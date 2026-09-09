// Behavioral checks for scripts/tackle-tasks/runFullSuite/MERGE_WORKTREES.ts. Mutating: uses real temp git repos seeded inline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./MERGE_WORKTREES.ts";
import { rebaseTaskWorktree } from "../shared/rebaseTaskWorktree.ts";
import { acquireSourceRepoLock, buildLockOwner, releaseSourceRepoLock } from "../shared/sourceRepoLock.ts";
import { claimTask, getCurrentTaskRun } from "../shared/taskRunState.ts";
import { createWorktreeForGroup } from "../../shared/prepareTasks.ts";
import { resolveTaskFiles } from "../../shared/taskFiles.ts";
import { writeJsonAtomically } from "../../shared/taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

const FIXTURE_PACKAGE_JSON = JSON.stringify({ scripts: { test: "true" } });

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

// Seeds a fresh repo from an inline fixture, never from real project state.
function makeTempRepoFromFixture(branchName: string): string {
    const repoPath = tmpMkdir("merge-worktrees-step-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "package.json"), FIXTURE_PACKAGE_JSON);
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function makeSourceRepoWithSubmodule(): string {
    // Not "staging": baseBranchResolution deliberately never resolves "staging" as a base branch.
    const childOrigin = makeTempRepoFromFixture("child-main");
    const rootOrigin = makeTempRepoFromFixture("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return rootOrigin;
}

let nextGroupId = 1;
function createLinkedWorktree(rootOrigin: string): { worktree: string; taskNumber: number } {
    const groupId = nextGroupId++;
    const worktree = createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
    return { worktree, taskNumber: groupId };
}

function seedTaskAndMarkActive(projectRoot: string, taskNumber: number, runId: string): void {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", modifiableFiles: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
}

function commitTaskWorkInWorktree(worktree: string): void {
    writeFileSync(join(worktree, "child", "widget.txt"), "widget\n");
    git(join(worktree, "child"), "add", "widget.txt");
    git(join(worktree, "child"), "commit", "-q", "-m", "child work");
    git(worktree, "add", "child");
    git(worktree, "commit", "-q", "-m", "bump child gitlink");
    writeFileSync(join(worktree, "root-work.txt"), "root work\n");
    git(worktree, "add", "root-work.txt");
    git(worktree, "commit", "-q", "-m", "root work");
}

// F3 precondition: task marked active and rebased first, so this run carries the source-tip receipt.
async function markActiveCommitAndRebase(rootOrigin: string, taskNumber: number, worktree: string, runId: string): Promise<void> {
    seedTaskAndMarkActive(rootOrigin, taskNumber, runId);
    commitTaskWorkInWorktree(worktree);
    const rebaseResult = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath: worktree, taskNumber, runId, stepId: `rebase-${runId}`, rootSourceBranch: "staging",
    });
    assert.equal(rebaseResult.conflicted, false);
    assert.equal(rebaseResult.stoppedAt, null);
}

function packet(input: { projectRoot: string; worktree: string; taskNumber: number; runId: string }): string {
    return JSON.stringify(input);
}

test("test_MERGE_WORKTREES_mergesEveryLayerAndReturnsMergeCommits", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktree, taskNumber } = createLinkedWorktree(rootOrigin);
    await markActiveCommitAndRebase(rootOrigin, taskNumber, worktree, "run-30");

    const result = main(packet({ projectRoot: rootOrigin, worktree, taskNumber, runId: "run-30" }));

    assert.equal(result.box, "MERGE_WORKTREES");
    assert.equal(result.merged, true);
    assert.equal(result.failureReason, "");
    const commits = result.commits as { kind: string; occurrenceId: string }[];
    assert.deepEqual(commits.map((commit) => commit.kind), ["merge", "merge"]);
    assert.deepEqual(commits.map((commit) => commit.occurrenceId).sort(), ["", "child"]);
});

test("test_MERGE_WORKTREES_runsTwiceWithTheSameInput", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktree, taskNumber } = createLinkedWorktree(rootOrigin);
    await markActiveCommitAndRebase(rootOrigin, taskNumber, worktree, "run-40");
    const input = packet({ projectRoot: rootOrigin, worktree, taskNumber, runId: "run-40" });

    const first = main(input);
    const rootOriginHeadAfterFirst = git(rootOrigin, "rev-parse", "HEAD");
    const runAfterFirst = getCurrentTaskRun(taskNumber, rootOrigin);

    const second = main(input);
    const rootOriginHeadAfterSecond = git(rootOrigin, "rev-parse", "HEAD");
    const runAfterSecond = getCurrentTaskRun(taskNumber, rootOrigin);

    assert.deepEqual(second, first);
    assert.equal(rootOriginHeadAfterSecond, rootOriginHeadAfterFirst);
    assert.deepEqual(runAfterSecond, runAfterFirst);
});

test("test_MERGE_WORKTREES_createsAMergeCommitWithTwoParents", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktree, taskNumber } = createLinkedWorktree(rootOrigin);
    await markActiveCommitAndRebase(rootOrigin, taskNumber, worktree, "run-31");

    const result = main(packet({ projectRoot: rootOrigin, worktree, taskNumber, runId: "run-31" }));
    assert.equal(result.merged, true);

    const commits = result.commits as { occurrenceId: string; hash: string }[];
    const rootMergeCommit = commits.find((commit) => commit.occurrenceId === "")!;
    const parents = git(rootOrigin, "log", "-1", "--format=%P", rootMergeCommit.hash).split(" ").filter(Boolean);
    assert.equal(parents.length, 2);
});

// Superseded by the staging-worktree redesign: rootOrigin dirt no longer blocks a merge, so this is now false.
/*
test("test_MERGE_WORKTREES_refusesWhenTheSourceCheckoutWentDirty", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktree, taskNumber } = createLinkedWorktree(rootOrigin);
    await markActiveCommitAndRebase(rootOrigin, taskNumber, worktree, "run-32");

    // An unrelated dirty change lands in the source checkout while the lock was held.
    writeFileSync(join(rootOrigin, "uncommitted.txt"), "oops\n");

    assert.throws(
        () => main(packet({ projectRoot: rootOrigin, worktree, taskNumber, runId: "run-32" })),
        /dirty/,
    );
});
*/

test("test_MERGE_WORKTREES_refusesAndMutatesNothingWhenTheLockIsHeldByAnotherRun", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktree, taskNumber } = createLinkedWorktree(rootOrigin);
    await markActiveCommitAndRebase(rootOrigin, taskNumber, worktree, "run-35");
    const beforeHead = git(rootOrigin, "rev-parse", "HEAD");

    // Recover/reassign the lock to a different run entirely, then a delayed merge call must refuse before touching anything.
    releaseSourceRepoLock(rootOrigin, buildLockOwner("run-35", taskNumber));
    acquireSourceRepoLock(rootOrigin, buildLockOwner("other-run", taskNumber));

    assert.throws(() => main(packet({ projectRoot: rootOrigin, worktree, taskNumber, runId: "run-35" })));

    assert.equal(git(rootOrigin, "rev-parse", "HEAD"), beforeHead);
    const run = getCurrentTaskRun(taskNumber, rootOrigin);
    assert.deepEqual(run?.commits, []);
});
