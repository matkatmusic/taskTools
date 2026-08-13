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
import { claimTask, getCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../scripts/taskStateLock.ts";
import { git, makeCommittedRepo } from "./support/gitFixtures.ts";

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "releaseTaskRunHolds-"));
    mkdirSync(join(root, ".git"), { recursive: true });
    return root;
}

let nextTaskNumber = 1;
function seedTaskAndClaim(projectRoot: string, runId: string): number {
    const taskNumber = nextTaskNumber++;
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
    return taskNumber;
}

function releaseHolds(projectRoot: string, worktree: string | null, branchName: string | null) {
    const runId = "run-a";
    const taskNumber = seedTaskAndClaim(projectRoot, runId);
    return releaseTaskRunHolds({ taskNumber, runId, projectRoot, worktree, branchName, stepId: `step-${taskNumber}` });
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
    const output = releaseHolds(root, worktreePath, null);

    assert.deepEqual(output, { leaseReleased: false, leaseRetained: false, lockReleased: true });
    const leaseOwner = readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath));
    assert.equal(leaseOwner?.runId, "run-other");
    assert.equal(readSourceRepoLock(root), null);
});

test("test_releaseTaskRunHolds_reportsNothingHeldWhenThereIsNoWorktree", () => {
    // Scenario: the `blocked` exit fires before any worktree exists.
    const root = makeProjectRoot();

    const output = releaseHolds(root, null, null);

    assert.deepEqual(output, { leaseReleased: false, leaseRetained: false, lockReleased: false });
});

test("test_releaseTaskRunHolds_retainsTheLeaseWhileTheWorktreeRemains", () => {
    // Scenario: cleanup failed to remove the worktree, so it still exists on disk. F5: the
    // lease this run owns must be kept, not released, even though the source lock always is.
    const root = makeProjectRoot();
    const worktreePath = join(root, "worktree-1");
    mkdirSync(worktreePath, { recursive: true });
    const runId = "run-a";
    const taskNumber = seedTaskAndClaim(root, runId);
    acquireTaskWorktreeLease(worktreePath, "run-a");
    acquireSourceRepoLock(root, buildLockOwner("run-a", taskNumber));

    const output = releaseTaskRunHolds({
        taskNumber, runId, projectRoot: root, worktree: worktreePath, branchName: null, stepId: "step-x",
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
    const runId = "run-a";
    const taskNumber = seedTaskAndClaim(root, runId);
    acquireTaskWorktreeLease(worktreePath, "run-a");
    acquireSourceRepoLock(root, buildLockOwner("run-a", taskNumber));

    const output = releaseTaskRunHolds({
        taskNumber, runId, projectRoot: root, worktree: worktreePath, branchName: "task-1", stepId: "step-x",
    });

    assert.deepEqual(output, { leaseReleased: false, leaseRetained: true, lockReleased: true });
    assert.equal(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath))?.runId, "run-a");
});

test("test_releaseTaskRunHolds_releasesTheLeaseOnceNothingRemains", () => {
    // Scenario: the worktree is gone and the task branch is gone (cleanup succeeded, or a
    // prior exit already reconciled) — the lease this run owns can finally be released.
    const root = makeCommittedRepo("releaseTaskRunHolds-clean-");
    const worktreePath = join(root, "gone-worktree");
    const runId = "run-a";
    const taskNumber = seedTaskAndClaim(root, runId);
    acquireTaskWorktreeLease(worktreePath, "run-a");
    acquireSourceRepoLock(root, buildLockOwner("run-a", taskNumber));

    const output = releaseTaskRunHolds({
        taskNumber, runId, projectRoot: root, worktree: worktreePath, branchName: "task-1", stepId: "step-x",
    });

    assert.deepEqual(output, { leaseReleased: true, leaseRetained: false, lockReleased: true });
    assert.equal(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath)), null);
    assert.equal(readSourceRepoLock(root), null);
});

test("test_releaseTaskRunHolds_neverReturnsANonBooleanReleaseStateForAnyReachableInput", () => {
    // The real script always observes the lock and lease before mutating, so it can always tell
    // whether each was released - the returned fields are plain booleans, never a tri-state guess.
    const scenarios: Array<[string, () => ReturnType<typeof releaseTaskRunHolds>]> = [
        ["no worktree, no lock held", () => releaseHolds(makeProjectRoot(), null, null)],
        ["worktree with a lease held by another run", () => {
            const root = makeProjectRoot();
            const worktreePath = join(root, "worktree-1");
            mkdirSync(worktreePath, { recursive: true });
            acquireTaskWorktreeLease(worktreePath, "run-other");
            return releaseHolds(root, worktreePath, null);
        }],
        ["worktree remains, lease held by this run", () => {
            const root = makeProjectRoot();
            const worktreePath = join(root, "worktree-1");
            mkdirSync(worktreePath, { recursive: true });
            acquireTaskWorktreeLease(worktreePath, "run-a");
            return releaseHolds(root, worktreePath, null);
        }],
        ["nothing remains, lease held by this run", () => {
            const root = makeCommittedRepo("releaseTaskRunHolds-neverunknown-");
            const worktreePath = join(root, "gone-worktree");
            acquireTaskWorktreeLease(worktreePath, "run-a");
            return releaseHolds(root, worktreePath, "task-1");
        }],
    ];

    for (const [description, run] of scenarios) {
        const output = run();
        assert.equal(typeof output.leaseReleased, "boolean", `leaseReleased was not boolean for: ${description}`);
        assert.equal(typeof output.lockReleased, "boolean", `lockReleased was not boolean for: ${description}`);
    }
});

// F10: the exact real return value is persisted onto the run before this returns.
test("test_releaseTaskRunHolds_persistsAStepResultReceiptOntoTheRun", () => {
    const root = makeProjectRoot();
    const runId = "run-a";
    const taskNumber = seedTaskAndClaim(root, runId);
    acquireSourceRepoLock(root, buildLockOwner(runId, taskNumber));

    const output = releaseTaskRunHolds({
        taskNumber, runId, projectRoot: root, worktree: null, branchName: null, stepId: "release-step-1",
    });

    const run = getCurrentTaskRun(taskNumber, root) as { stepResults?: { stepId: string; script: string; result: unknown }[] } | null;
    const receipt = run?.stepResults?.find((entry) => entry.stepId === "release-step-1");
    assert.ok(receipt);
    assert.deepEqual(receipt!.result, output);
});
