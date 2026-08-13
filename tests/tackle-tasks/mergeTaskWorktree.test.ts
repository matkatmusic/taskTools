// Behavioral checks for scripts/tackle-tasks/mergeTaskWorktree.ts. Run: node --test tests/tackle-tasks/mergeTaskWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeTaskWorktree } from "../../scripts/tackle-tasks/mergeTaskWorktree.ts";
import { rebaseTaskWorktree } from "../../scripts/tackle-tasks/rebaseTaskWorktree.ts";
import { acquireSourceRepoLock, buildLockOwner, releaseSourceRepoLock } from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { claimTask, getCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";
import { currentBranchName } from "../../scripts/repositoryBranches.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../scripts/taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempRepoWithTestScript(branchName: string): string {
    const repoPath = tmpMkdir("merge-task-worktree-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeTempRepoWithTestScript("child-main");
    const rootOrigin = makeTempRepoWithTestScript("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return rootOrigin;
}

let nextGroupId = 1;
// operationBranch is attached as "task-<taskNumber>" by the script under test, so taskNumber
// here must equal the worktree's real groupId - matching production's one-task-per-group.
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

// The full precondition for a merge under F3: the task must have been claimed and rebased
// first, so the current run carries the source-tip receipt the merge box verifies.
async function claimCommitAndRebase(rootOrigin: string, taskNumber: number, worktreePath: string, runId: string): Promise<string> {
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    commitTaskWorkInWorktree(worktreePath);
    const sourceBranch = currentBranchName(rootOrigin);
    const rebaseResult = await rebaseTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId, rootSourceBranch: sourceBranch,
    });
    assert.equal(rebaseResult.conflicted, false);
    assert.equal(rebaseResult.stoppedAt, null);
    return sourceBranch;
}

test("test_mergeTaskWorktree_mergesEveryLayerAndReturnsMergeCommits", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const sourceBranch = await claimCommitAndRebase(rootOrigin, taskNumber, worktreePath, "run-30");

    const result = mergeTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-30", rootSourceBranch: sourceBranch,
    });

    assert.equal(result.merged, true);
    assert.equal(result.failureReason, null);
    assert.deepEqual(result.commits.map((commit) => commit.kind), ["merge", "merge"]);
    assert.deepEqual(result.commits.map((commit) => commit.occurrenceId).sort(), ["", "child"]);
});

test("test_mergeTaskWorktree_createsAMergeCommitWithTwoParents", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const sourceBranch = await claimCommitAndRebase(rootOrigin, taskNumber, worktreePath, "run-31");

    const result = mergeTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-31", rootSourceBranch: sourceBranch,
    });
    assert.equal(result.merged, true);

    const rootMergeCommit = result.commits.find((commit) => commit.occurrenceId === "")!;
    const parents = git(rootOrigin, "log", "-1", "--format=%P", rootMergeCommit.hash).split(" ").filter(Boolean);
    assert.equal(parents.length, 2);
});

test("test_mergeTaskWorktree_refusesWhenTheSourceCheckoutWentDirty", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const sourceBranch = await claimCommitAndRebase(rootOrigin, taskNumber, worktreePath, "run-32");

    // An unrelated dirty change lands in the source checkout while the lock was held.
    writeFileSync(join(rootOrigin, "uncommitted.txt"), "oops\n");

    assert.throws(() => mergeTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-32", rootSourceBranch: sourceBranch,
    }), /dirty/);
});

test("test_mergeTaskWorktree_refusesWhenAnUnrelatedCleanRootCommitLandedAfterRebase", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const sourceBranch = await claimCommitAndRebase(rootOrigin, taskNumber, worktreePath, "run-33");

    // A clean, committed, unrelated root change lands in the source checkout after rebase.
    // The branch name is unchanged and the checkout is clean, so the old branch-name+dirty
    // check alone would miss this (F3).
    writeFileSync(join(rootOrigin, "unrelated.txt"), "unrelated\n");
    git(rootOrigin, "add", "unrelated.txt");
    git(rootOrigin, "commit", "-q", "-m", "unrelated clean root change");

    assert.throws(() => mergeTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-33", rootSourceBranch: sourceBranch,
    }));
});

test("test_mergeTaskWorktree_refusesWhenACommittedSourceSubmoduleChangeLandedAfterRebase", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const sourceBranch = await claimCommitAndRebase(rootOrigin, taskNumber, worktreePath, "run-34");

    // A committed source-submodule change plus its root gitlink bump lands after rebase.
    const rootOriginChildPath = join(rootOrigin, "child");
    writeFileSync(join(rootOriginChildPath, "late.txt"), "late\n");
    git(rootOriginChildPath, "add", "late.txt");
    git(rootOriginChildPath, "commit", "-q", "-m", "late source child change");
    git(rootOrigin, "add", "child");
    git(rootOrigin, "commit", "-q", "-m", "bump child gitlink for late change");

    assert.throws(() => mergeTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-34", rootSourceBranch: sourceBranch,
    }));
});

test("test_mergeTaskWorktree_refusesAndMutatesNothingWhenTheLockIsHeldByAnotherRun", async () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    const sourceBranch = await claimCommitAndRebase(rootOrigin, taskNumber, worktreePath, "run-35");
    const beforeHead = git(rootOrigin, "rev-parse", "HEAD");

    // Recover/reassign the lock to a different run entirely, then a delayed run-35 merge call
    // must refuse before touching anything.
    releaseSourceRepoLock(rootOrigin, buildLockOwner("run-35", taskNumber));
    acquireSourceRepoLock(rootOrigin, buildLockOwner("other-run", taskNumber));

    assert.throws(() => mergeTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-35", rootSourceBranch: sourceBranch,
    }));

    assert.equal(git(rootOrigin, "rev-parse", "HEAD"), beforeHead);
    const run = getCurrentTaskRun(taskNumber, rootOrigin);
    assert.deepEqual(run?.commits, []);
});
