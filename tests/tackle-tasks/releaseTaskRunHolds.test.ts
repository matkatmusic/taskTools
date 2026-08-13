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
    const output = releaseTaskRunHolds({ taskNumber: 1, runId: "run-a", projectRoot: root, worktree: worktreePath });

    assert.deepEqual(output, { leaseReleased: false, lockReleased: true });
    const leaseOwner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath));
    assert.equal(leaseOwner?.runId, "run-other");
    assert.equal(readSourceRepoLock(root), null);
});

test("test_releaseTaskRunHolds_releasesALeaseAndLockThisRunOwns", () => {
    // Scenario: both the worktree lease and the source lock belong to the exiting run.
    const root = makeProjectRoot();
    const worktreePath = join(root, "worktree-1");
    mkdirSync(worktreePath, { recursive: true });
    acquireTaskWorktreeLease(worktreePath, "run-a");
    acquireSourceRepoLock(root, buildLockOwner("run-a", 1));

    const output = releaseTaskRunHolds({ taskNumber: 1, runId: "run-a", projectRoot: root, worktree: worktreePath });

    assert.deepEqual(output, { leaseReleased: true, lockReleased: true });
    assert.equal(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath)), null);
    assert.equal(readSourceRepoLock(root), null);
});

test("test_releaseTaskRunHolds_reportsNothingHeldWhenThereIsNoWorktree", () => {
    // Scenario: the `blocked` exit fires before any worktree exists.
    const root = makeProjectRoot();

    const output = releaseTaskRunHolds({ taskNumber: 1, runId: "run-a", projectRoot: root, worktree: null });

    assert.deepEqual(output, { leaseReleased: false, lockReleased: false });
});
