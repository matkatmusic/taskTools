// Behavioral checks for scripts/tackle-tasks/releaseTaskRunHolds.ts.
// Run: node --test tests/tackle-tasks/releaseTaskRunHolds.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTaskRunHolds } from "../../scripts/tackle-tasks/releaseTaskRunHolds.ts";
import { acquireTaskWorktreeLease, readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../../scripts/prepareTasks.ts";
import { acquireSourceRepoLock, buildLockOwner, readSourceRepoLock } from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { git, makeCommittedRepo } from "./support/gitFixtures.ts";

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "releaseTaskRunHolds-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
}

test("test_releaseTaskRunHolds_leavesALeaseHeldByAnotherOwnerAlone", () => {
    // Scenario: the worktree lease belongs to a different run than the one exiting, and the
    // source lock belongs to this run.
    const root = makeProjectRoot();
    const worktreePath = join(root, "worktree-1");
    mkdirSync(worktreePath, { recursive: true });
    acquireTaskWorktreeLease(worktreePath, "run-other");
    const owner = buildLockOwner("run-a", 1);
    acquireSourceRepoLock(root, owner);

    // Releasing holds for "run-a" must not touch the lease held by "run-other", but must
    // release the source lock this run does own.
    const output = releaseTaskRunHolds({
        taskNumber: 1, runId: "run-a", projectRoot: root, worktree: worktreePath, branchName: null,
    });

    assert.deepEqual(output, { leaseReleased: false, leaseRetained: false, lockReleased: true });
    const leaseOwner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath));
    assert.equal(leaseOwner?.runId, "run-other");
    assert.equal(readSourceRepoLock(root), null);
});

test("test_releaseTaskRunHolds_reportsNothingHeldWhenThereIsNoWorktree", () => {
    // Scenario: the `blocked` exit fires before any worktree exists.
    const root = makeProjectRoot();

    const output = releaseTaskRunHolds({
        taskNumber: 1, runId: "run-a", projectRoot: root, worktree: null, branchName: null,
    });

    assert.deepEqual(output, { leaseReleased: false, leaseRetained: false, lockReleased: false });
});

test("test_releaseTaskRunHolds_retainsTheLeaseWhileTheWorktreeRemains", () => {
    // Scenario: cleanup failed to remove the worktree, so it still exists on disk. F5: the
    // lease this run owns must be kept, not released, even though the source lock always is.
    const root = makeProjectRoot();
    const worktreePath = join(root, "worktree-1");
    mkdirSync(worktreePath, { recursive: true });
    acquireTaskWorktreeLease(worktreePath, "run-a");
    acquireSourceRepoLock(root, buildLockOwner("run-a", 1));

    const output = releaseTaskRunHolds({
        taskNumber: 1, runId: "run-a", projectRoot: root, worktree: worktreePath, branchName: null,
    });

    assert.deepEqual(output, { leaseReleased: false, leaseRetained: true, lockReleased: true });
    assert.equal(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath))?.runId, "run-a");
    assert.equal(readSourceRepoLock(root), null);
});

test("test_releaseTaskRunHolds_retainsTheLeaseWhileARetainedTaskBranchRemains", () => {
    // Scenario: the worktree itself is gone, but the task branch cleanup would have deleted
    // is still present in the main repo — that is still retained work.
    const root = makeCommittedRepo("releaseTaskRunHolds-branch-");
    git(root, "branch", "task-1");
    const worktreePath = join(root, "gone-worktree");
    acquireTaskWorktreeLease(worktreePath, "run-a");
    acquireSourceRepoLock(root, buildLockOwner("run-a", 1));

    const output = releaseTaskRunHolds({
        taskNumber: 1, runId: "run-a", projectRoot: root, worktree: worktreePath, branchName: "task-1",
    });

    assert.deepEqual(output, { leaseReleased: false, leaseRetained: true, lockReleased: true });
    assert.equal(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath))?.runId, "run-a");
});

test("test_releaseTaskRunHolds_releasesTheLeaseOnceNothingRemains", () => {
    // Scenario: the worktree is gone and the task branch is gone (cleanup succeeded, or a
    // prior exit already reconciled) — the lease this run owns can finally be released.
    const root = makeCommittedRepo("releaseTaskRunHolds-clean-");
    const worktreePath = join(root, "gone-worktree");
    acquireTaskWorktreeLease(worktreePath, "run-a");
    acquireSourceRepoLock(root, buildLockOwner("run-a", 1));

    const output = releaseTaskRunHolds({
        taskNumber: 1, runId: "run-a", projectRoot: root, worktree: worktreePath, branchName: "task-1",
    });

    assert.deepEqual(output, { leaseReleased: true, leaseRetained: false, lockReleased: true });
    assert.equal(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath)), null);
    assert.equal(readSourceRepoLock(root), null);
});
