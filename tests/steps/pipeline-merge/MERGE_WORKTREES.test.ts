// Behavioral checks for scripts/steps/pipeline-merge/MERGE_WORKTREES.ts. Mutating: uses real temp git repos seeded inline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-merge/MERGE_WORKTREES.ts";
import { rebaseTaskWorktree } from "../../../scripts/tackle-tasks/rebaseTaskWorktree.ts";
import { acquireSourceRepoLock, buildLockOwner, releaseSourceRepoLock } from "../../../scripts/tackle-tasks/sourceRepoLock.ts";
import { claimTask, getCurrentTaskRun } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup } from "../../../scripts/prepareTasks.ts";
import { currentBranchName } from "../../../scripts/repositoryBranches.ts";
import { resolveTaskFiles } from "../../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../../scripts/taskStateLock.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-merge/MERGE_WORKTREES.template.json");
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
    const childOrigin = makeTempRepoFromFixture("child-main");
    const rootOrigin = makeTempRepoFromFixture("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return rootOrigin;
}

let nextGroupId = 1;
function createLinkedWorktree(rootOrigin: string): { worktreePath: string; taskNumber: number } {
    const groupId = nextGroupId++;
    const worktreePath = createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
    return { worktreePath, taskNumber: groupId };
}

function seedTaskAndClaim(projectRoot: string, taskNumber: number, runId: string): void {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
}

function commitTaskWorkInWorktree(worktreePath: string): void {
    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    git(join(worktreePath, "child"), "add", "widget.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "child work");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    writeFileSync(join(worktreePath, "root-work.txt"), "root work\n");
    git(worktreePath, "add", "root-work.txt");
    git(worktreePath, "commit", "-q", "-m", "root work");
}

// F3 precondition: task marked active and rebased first, so this run carries the source-tip receipt.
async function claimCommitAndRebase(rootOrigin: string, taskNumber: number, worktreePath: string, runId: string): Promise<string> {
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    commitTaskWorkInWorktree(worktreePath);
    const sourceBranch = currentBranchName(rootOrigin);
    const rebaseResult = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId, stepId: `rebase-${runId}`, rootSourceBranch: sourceBranch,
    });
    assert.equal(rebaseResult.conflicted, false);
    assert.equal(rebaseResult.stoppedAt, null);
    return sourceBranch;
}

function packet(input: {
    projectRoot: string; worktreePath: string; taskNumber: number; runId: string; rootSourceBranch: string; suiteFixAttempts?: number;
}): string {
    return JSON.stringify({ suiteFixAttempts: 0, ...input });
}

test("test_MERGE_WORKTREES_mergesEveryLayerAndReturnsMergeCommits", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const rootSourceBranch = await claimCommitAndRebase(rootOrigin, taskNumber, worktreePath, "run-30");

    const result = main(packet({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-30", rootSourceBranch }));

    assert.equal(result.box, "MERGE_WORKTREES");
    assert.equal(result.merged, true);
    assert.equal(result.failureReason, null);
    assert.equal(result.suiteFixAttempts, 0);
    const commits = result.commits as { kind: string; occurrenceId: string }[];
    assert.deepEqual(commits.map((commit) => commit.kind), ["merge", "merge"]);
    assert.deepEqual(commits.map((commit) => commit.occurrenceId).sort(), ["", "child"]);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, result), []);
});

test("test_MERGE_WORKTREES_createsAMergeCommitWithTwoParents", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const rootSourceBranch = await claimCommitAndRebase(rootOrigin, taskNumber, worktreePath, "run-31");

    const result = main(packet({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-31", rootSourceBranch }));
    assert.equal(result.merged, true);

    const commits = result.commits as { occurrenceId: string; hash: string }[];
    const rootMergeCommit = commits.find((commit) => commit.occurrenceId === "")!;
    const parents = git(rootOrigin, "log", "-1", "--format=%P", rootMergeCommit.hash).split(" ").filter(Boolean);
    assert.equal(parents.length, 2);
});

test("test_MERGE_WORKTREES_refusesWhenTheSourceCheckoutWentDirty", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const rootSourceBranch = await claimCommitAndRebase(rootOrigin, taskNumber, worktreePath, "run-32");

    // An unrelated dirty change lands in the source checkout while the lock was held.
    writeFileSync(join(rootOrigin, "uncommitted.txt"), "oops\n");

    assert.throws(
        () => main(packet({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-32", rootSourceBranch })),
        /dirty/,
    );
});

test("test_MERGE_WORKTREES_refusesAndMutatesNothingWhenTheLockIsHeldByAnotherRun", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const rootSourceBranch = await claimCommitAndRebase(rootOrigin, taskNumber, worktreePath, "run-35");
    const beforeHead = git(rootOrigin, "rev-parse", "HEAD");

    // Recover/reassign the lock to a different run entirely, then a delayed run-35 merge call must refuse before touching anything.
    releaseSourceRepoLock(rootOrigin, buildLockOwner("run-35", taskNumber));
    acquireSourceRepoLock(rootOrigin, buildLockOwner("other-run", taskNumber));

    assert.throws(() => main(packet({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-35", rootSourceBranch })));

    assert.equal(git(rootOrigin, "rev-parse", "HEAD"), beforeHead);
    const run = getCurrentTaskRun(taskNumber, rootOrigin);
    assert.deepEqual(run?.commits, []);
});
