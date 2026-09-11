// Shared setup and assertions for tests/mergeStaging/*.test.ts: a two-submodule ahead-head fixture and a spawned task-N worktree.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert";
import { git } from "../support/gitFixtures.ts";
import { makeShapeFixture, type RepoNode, type ShapeFixture } from "../support/repoShapeFixtures.ts";
import { createTaskWorktree } from "../../scripts/tackle-tasks/shared/createTaskWorktree.ts";
import { claimTask } from "../../scripts/tackle-tasks/shared/taskRunState.ts";
import { mergeWorktreeTaskDeepestFirst } from "../../scripts/tackle-tasks/shared/occurrences.ts";
import type { MergeTaskWalkReport } from "../../scripts/merge-worktree-tasks/mergeTaskWorktrees.ts";

export const TASK_NUMBER = 2;
export const BRANCH = `task-${TASK_NUMBER}`;
const RUN_ID = "run-mergeStaging";

export type OccurrenceId = "root" | "sub-a" | "sub-b";

export type Spawned = { fixture: ShapeFixture; worktree: string; projectRoot: string };

export function repoNode(fixture: ShapeFixture, occurrenceId: OccurrenceId): RepoNode {
    const node = fixture.repos.find((candidate) => candidate.occurrenceId === occurrenceId);
    if (node === undefined) throw new Error(`no repo node "${occurrenceId}" in fixture`);
    return node;
}

function worktreeCheckoutPath(worktree: string, occurrenceId: string): string {
    return occurrenceId === "root" ? worktree : join(worktree, occurrenceId);
}

export function buildFixture(): ShapeFixture {
    return makeShapeFixture("two-submodules", "ahead-head", TASK_NUMBER);
}

// Commits onto "staging", then restores the original checkout, using --detach for a detached HEAD since --abbrev-ref reads back "HEAD".
export function commitOnStaging(repoPath: string, relFile: string, content: string): void {
    const checkedOutBranch = git(repoPath, "branch", "--show-current");
    const checkedOutCommit = checkedOutBranch === "" ? git(repoPath, "rev-parse", "HEAD") : "";
    git(repoPath, "checkout", "-q", "staging");
    writeFileSync(join(repoPath, relFile), content);
    git(repoPath, "add", relFile);
    git(repoPath, "commit", "-q", "-m", `staging: ${relFile}`);
    if (checkedOutBranch === "") {
        git(repoPath, "checkout", "-q", "--detach", checkedOutCommit);
    } else {
        git(repoPath, "checkout", "-q", checkedOutBranch);
    }
}

// Which worktree of repoPath's repo (if any) currently has branch checked out; null if none does.
function worktreeCheckedOutOn(repoPath: string, branch: string): string | null {
    const blocks = git(repoPath, "worktree", "list", "--porcelain").split("\n\n").map((block) => block.trim()).filter(Boolean);
    for (const block of blocks) {
        const lines = block.split("\n");
        const pathLine = lines.find((line) => line.startsWith("worktree "));
        if (pathLine && lines.includes(`branch refs/heads/${branch}`)) return pathLine.slice("worktree ".length);
    }
    return null;
}

// Force-moves "staging" back to an earlier tip. Resets the linked staging worktree directly once a merge has run.
export function resetStagingTo(repoPath: string, tip: string): void {
    const stagingWorktree = worktreeCheckedOutOn(repoPath, "staging");
    if (stagingWorktree !== null) {
        git(stagingWorktree, "reset", "-q", "--hard", tip);
        return;
    }
    const checkedOutBranch = git(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
    git(repoPath, "checkout", "-q", "staging");
    git(repoPath, "reset", "-q", "--hard", tip);
    git(repoPath, "checkout", "-q", checkedOutBranch);
}

export function spawnWorktree(fixture: ShapeFixture): Spawned {
    const projectRoot = fixture.rootPath;
    writeFileSync(
        join(projectRoot, "tasks.json"),
        `${JSON.stringify([{ taskNumber: TASK_NUMBER, title: "t", modifiableFiles: [] }], null, 2)}\n`,
    );
    claimTask(TASK_NUMBER, RUN_ID, projectRoot);
    const { worktree } = createTaskWorktree(TASK_NUMBER, RUN_ID, projectRoot);
    return { fixture, worktree, projectRoot };
}

// Commits task work for occurrenceId; a submodule edit walks up every ancestor (deepest parent first, root last), bumping each ancestor's gitlink for its direct child so the change is visible all the way to root, not just its immediate parent.
export function commitTaskWork(worktree: string, occurrenceId: string, relFile: string, content: string): void {
    const dir = worktreeCheckoutPath(worktree, occurrenceId);
    writeFileSync(join(dir, relFile), content);
    git(dir, "add", relFile);
    git(dir, "commit", "-q", "-m", `task work: ${relFile}`);
    if (occurrenceId !== "root") {
        const segments = occurrenceId.split("/");
        for (let i = segments.length - 1; i >= 0; i--) {
            const ancestorOccurrenceId = i === 0 ? "root" : segments.slice(0, i).join("/");
            const childSegment = segments[i];
            const ancestorDir = worktreeCheckoutPath(worktree, ancestorOccurrenceId);
            git(ancestorDir, "add", childSegment);
            git(ancestorDir, "commit", "-q", "-m", `bump ${childSegment} gitlink`);
        }
    }
}

// No test suite in any shape-fixture repo, so runTests=false, matching mergeTaskWorktree.ts's own call.
export function merge(spawned: Spawned): MergeTaskWalkReport {
    return mergeWorktreeTaskDeepestFirst(spawned.worktree, spawned.projectRoot, TASK_NUMBER, "staging", undefined, null, false);
}

export function mergedCommitsRef(): string {
    return `refs/taskTools/merged-commits/${BRANCH}`;
}

export function refPresent(repoPath: string, ref: string): boolean {
    try {
        git(repoPath, "rev-parse", "--verify", "--quiet", ref);
        return true;
    } catch {
        return false;
    }
}

export function gitlinkAt(repoPath: string, ref: string, relPath: string): string {
    return git(repoPath, "ls-tree", ref, relPath).trim().split(/\s+/)[2];
}

// Checks merge commit, task-N branch, merged-commits ref, and parent gitlink; expectParentGitlink skips that last check pre-propagation.
export function assertMerged(spawned: Spawned, occurrenceId: OccurrenceId, expectParentGitlink: boolean = true): void {
    const node = repoNode(spawned.fixture, occurrenceId);
    const stagingTip = git(node.checkoutPath, "rev-parse", "staging");
    const parents = git(node.checkoutPath, "log", "-1", "--format=%P", stagingTip).split(" ").filter(Boolean);
    assert.equal(parents.length, 2, `${occurrenceId} staging tip is not a merge commit`);
    // A touched child's branch may since have fast-forwarded to its merge commit via the parent's gitlink propagation.
    const dir = worktreeCheckoutPath(spawned.worktree, occurrenceId);
    const dirTip = git(dir, "rev-parse", BRANCH);
    if (dirTip !== parents[1]) {
        assert.doesNotThrow(() => git(dir, "merge-base", "--is-ancestor", parents[1], dirTip), `${occurrenceId} merge ^2 is not reachable from task-N tip`);
    }
    assert.equal(git(dir, "branch", "--show-current"), BRANCH, `${occurrenceId} worktree left task-N`);
    assert.ok(refPresent(node.checkoutPath, mergedCommitsRef()), `${occurrenceId} missing merged-commits ref`);
    if (occurrenceId !== "root" && expectParentGitlink) {
        const rootPath = repoNode(spawned.fixture, "root").checkoutPath;
        assert.equal(gitlinkAt(rootPath, "staging", occurrenceId), stagingTip, `${occurrenceId} gitlink in root staging mismatch`);
    }
}

// Full shape for a repo task-N never touched: staging unchanged since the fixture was built, merged-commits ref still recorded.
export function assertUntouched(spawned: Spawned, occurrenceId: OccurrenceId): void {
    const node = repoNode(spawned.fixture, occurrenceId);
    assert.equal(git(node.checkoutPath, "rev-parse", "staging"), node.stagingTip, `${occurrenceId} staging moved`);
    assert.ok(refPresent(node.checkoutPath, mergedCommitsRef()), `${occurrenceId} missing merged-commits ref`);
}

export function stagingTipAt(repoPath: string): string {
    return git(repoPath, "rev-parse", "staging");
}

export function stagingTip(spawned: Spawned, occurrenceId: OccurrenceId): string {
    return stagingTipAt(repoNode(spawned.fixture, occurrenceId).checkoutPath);
}
