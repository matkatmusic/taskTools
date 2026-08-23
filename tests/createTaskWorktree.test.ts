// Behavioral checks for createTaskWorktree.ts. Run alone: node --test tests/createTaskWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskWorktree, taskBranchName, taskWorktreeCreateJournalPath } from "../scripts/tackle-tasks/createTaskWorktree.ts";
import { claimTask, readTaskRunState, updateCurrentTaskRun } from "../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup, resolveTaskWorktreeConventionDirectory, taskWorktreeLeasePath } from "../scripts/prepareTasks.ts";
import type { TaskGroup } from "../scripts/taskGroups.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeProjectRootWithLocalSubmodule(): { root: string; submoduleOrigin: string } {
    const submoduleOrigin = mkdtempSync(join(tmpdir(), "createTaskWorktree-sub-"));
    git(submoduleOrigin, "init", "-q");
    git(submoduleOrigin, "config", "user.email", "test@example.com");
    git(submoduleOrigin, "config", "user.name", "Test");
    writeFileSync(join(submoduleOrigin, "seed.txt"), "seed\n");
    git(submoduleOrigin, "add", "seed.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "seed");

    const root = mkdtempSync(join(tmpdir(), "createTaskWorktree-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "fileA.txt"), "root file\n");
    git(root, "add", "fileA.txt");
    git(root, "commit", "-q", "-m", "seed");
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(root, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(root, "commit", "-q", "-m", "add submodule");
    return { root, submoduleOrigin };
}

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_createTaskWorktree_createsARealWorktreeOnTheTasksBranchWithSubmodulesPopulated", () => {
    // Setup: a real repo with a real submodule, and an active claimed run for task 1.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: ["fileA.txt"] }]);
    claimTask(1, "run-a", root);

    // Test action: create the task worktree.
    const output = createTaskWorktree(1, "run-a", root);

    // Verification: a real linked worktree exists, checked out on the task's branch, submodule populated.
    assert.equal(output.branch, taskBranchName(1));
    assert.ok(existsSync(output.worktree));
    const currentBranch = git(output.worktree, "branch", "--show-current").trim();
    assert.equal(currentBranch, "task-1");
    assert.ok(existsSync(join(output.worktree, "vendor", "seed.txt")));
});

test("test_createTaskWorktree_recordsTheWorktreePathOnTheActiveRun", () => {
    // Setup: a real repo, an active claimed run.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);

    // Test action: create the worktree.
    const output = createTaskWorktree(1, "run-a", root);

    // Verification: the run state's worktree and leaseRunId reflect the new worktree.
    const state = readTaskRunState(1, root);
    assert.equal(state.worktree, output.worktree);
    assert.equal(state.leaseRunId, "run-a");
});

test("test_createTaskWorktree_rollsBackTheWorktreeAndLeaseWhenTaskStateRecordingFails", () => {
    // Setup: a claimed run "run-a", but createTaskWorktree is invoked with an unrelated runId
    // "run-b" so updateCurrentTaskRun's expectedRunId check fails after the real worktree and
    // lease already exist on disk.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");

    // Test action + verification: the mismatched runId throws.
    assert.throws(() => createTaskWorktree(1, "run-b", root));

    // Verification: no unrecorded worktree, task branch, lease or journal survived the rollback.
    assert.ok(!existsSync(expectedWorktree));
    assert.ok(!existsSync(taskWorktreeLeasePath(expectedWorktree)));
    assert.ok(!existsSync(taskWorktreeCreateJournalPath(expectedWorktree)));
    assert.throws(() => git(root, "rev-parse", "--verify", "refs/heads/task-1"));
    const state = readTaskRunState(1, root);
    assert.equal(state.worktree, null);
    assert.equal(state.leaseRunId, null);
});

test("test_createTaskWorktree_retainsTheLeaseAndExactJournalWhenRemovalFails", () => {
    // Setup: same task-state mismatch as above, but rollback's own worktree/branch removal is
    // sabotaged (simulating a real `git worktree remove` failure).
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    process.env.CREATETASKWORKTREE_TEST_FORCE_REMOVAL_FAILURE = "1";

    try {
        // Test action + verification: rollback failure surfaces as an aggregate error.
        assert.throws(() => createTaskWorktree(1, "run-b", root));
    } finally {
        delete process.env.CREATETASKWORKTREE_TEST_FORCE_REMOVAL_FAILURE;
    }

    // Verification: the lease still names this run — never released ahead of a failed removal.
    const leaseOwner = JSON.parse(readFileSync(taskWorktreeLeasePath(expectedWorktree), "utf8"));
    assert.equal(leaseOwner.runId, "run-b");

    // Verification: the journal survives with enough exact ownership data for recovery.
    const journalPath = taskWorktreeCreateJournalPath(expectedWorktree);
    assert.ok(existsSync(journalPath));
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    assert.deepEqual(
        { taskNumber: journal.taskNumber, runId: journal.runId, worktreePath: journal.worktreePath, branch: journal.branch },
        { taskNumber: 1, runId: "run-b", worktreePath: expectedWorktree, branch: "task-1" },
    );
});

test("test_createTaskWorktree_neverTouchesAnotherOwnersLeaseWorktreeOrBranchDuringRollback", () => {
    // Setup: same task-state mismatch, but before rollback re-reads the lease, another owner
    // has legitimately taken it over (the F11 finding: the old code released this run's lease
    // and then deleted the worktree anyway, destroying the new owner's claim).
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    process.env.CREATETASKWORKTREE_TEST_CORRUPT_LEASE_BEFORE_ROLLBACK = "1";

    try {
        // Test action + verification: rollback refuses and surfaces the mismatch.
        assert.throws(() => createTaskWorktree(1, "run-b", root));
    } finally {
        delete process.env.CREATETASKWORKTREE_TEST_CORRUPT_LEASE_BEFORE_ROLLBACK;
    }

    // Verification: the other owner's lease, the worktree, and the branch are all untouched.
    assert.ok(existsSync(expectedWorktree));
    const leaseOwner = JSON.parse(readFileSync(taskWorktreeLeasePath(expectedWorktree), "utf8"));
    assert.equal(leaseOwner.runId, "test-rollback-saboteur");
    assert.doesNotThrow(() => git(root, "rev-parse", "--verify", "refs/heads/task-1"));

    // Verification: the journal remains, naming this run's original claim.
    const journalPath = taskWorktreeCreateJournalPath(expectedWorktree);
    assert.ok(existsSync(journalPath));
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    assert.equal(journal.runId, "run-b");
});

test("test_createTaskWorktree_rollsBackFullyWhenCreateWorktreeForGroupFailsAfterWorktreeCreation", () => {
    // Setup: a real repo with a real submodule, and an active claimed run for task 1. Break the
    // submodule's only source of objects (both the cached copy and its origin) so `git worktree
    // add` itself still succeeds, but the submodule-init step inside createWorktreeForGroup
    // fails afterward.
    const { root, submoduleOrigin } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    rmSync(join(root, ".git", "modules", "vendor"), { recursive: true, force: true });
    rmSync(submoduleOrigin, { recursive: true, force: true });

    // Test action + verification: the broken submodule init throws.
    assert.throws(() => createTaskWorktree(1, "run-a", root));

    // Verification: same full-rollback contract as a task-state recording failure — nothing
    // this attempt created (worktree, branch, lease, journal) survives.
    assert.ok(!existsSync(expectedWorktree));
    assert.ok(!existsSync(taskWorktreeLeasePath(expectedWorktree)));
    assert.ok(!existsSync(taskWorktreeCreateJournalPath(expectedWorktree)));
    assert.throws(() => git(root, "rev-parse", "--verify", "refs/heads/task-1"));
    const state = readTaskRunState(1, root);
    assert.equal(state.worktree, null);
    assert.equal(state.leaseRunId, null);
});

// F1: fault injection for a journal retained by an earlier call that died AFTER task state was
// written but BEFORE it deleted its own journal - the creation genuinely finished.
test("test_createTaskWorktree_recoversALateCompletedJournalWithoutTouchingTheGoodWorktree", () => {
    // Setup: a real worktree/lease created and task state recorded for real (the creation truly
    // finished), then a journal is hand-written back to simulate death right before its unlink.
    // Before the fix, createTaskWorktree never looked for a retained journal at all: it would
    // overwrite this one, collide with the existing lease (EEXIST), and its own rollback would
    // then DESTROY this already-good worktree/branch before rethrowing - real data loss.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "declared" };
    const worktree = createWorktreeForGroup(root, group, "run-a");
    updateCurrentTaskRun(1, "run-a", { worktree, leaseRunId: "run-a" }, root);
    const journalPath = taskWorktreeCreateJournalPath(expectedWorktree);
    writeFileSync(journalPath, JSON.stringify({
        taskNumber: 1, runId: "run-a", worktreePath: expectedWorktree, branch: "task-1",
        createdAt: "2026-01-01T00:00:00+00:00",
    }));

    // Test action: rerun createTaskWorktree exactly as a resumed workflow would - must not throw.
    const output = createTaskWorktree(1, "run-a", root);

    // Verification: the already-created worktree is returned untouched, not rebuilt.
    assert.equal(output.worktree, worktree);
    assert.equal(output.branch, "task-1");
    assert.ok(existsSync(worktree));
    const leaseOwner = JSON.parse(readFileSync(taskWorktreeLeasePath(worktree), "utf8"));
    assert.equal(leaseOwner.runId, "run-a");
    assert.doesNotThrow(() => git(root, "rev-parse", "--verify", "refs/heads/task-1"));

    // Verification: the stale journal is gone, exactly once, and task state still matches.
    assert.ok(!existsSync(journalPath));
    const state = readTaskRunState(1, root);
    assert.equal(state.worktree, worktree);
    assert.equal(state.leaseRunId, "run-a");
});

// F1: fault injection for a journal retained by an earlier call that died with a real
// worktree/branch/lease created, but BEFORE task state was ever written.
test("test_createTaskWorktree_recoversARetainedJournalWithNoTaskStateRecordedYet", () => {
    // Setup: a real worktree/lease exist and a journal is hand-written to match, but
    // updateCurrentTaskRun never ran - task.run.worktree is still null. Before the fix this call
    // would overwrite the journal, collide with the existing lease (EEXIST), trigger rollback,
    // and throw instead of transparently recovering in one call.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "declared" };
    createWorktreeForGroup(root, group, "run-a");
    const journalPath = taskWorktreeCreateJournalPath(expectedWorktree);
    writeFileSync(journalPath, JSON.stringify({
        taskNumber: 1, runId: "run-a", worktreePath: expectedWorktree, branch: "task-1",
        createdAt: "2026-01-01T00:00:00+00:00",
    }));

    // Test action: rerun createTaskWorktree exactly as a resumed workflow would - one call, no throw.
    const output = createTaskWorktree(1, "run-a", root);

    // Verification: exactly one fresh worktree/branch/lease exists, recorded on task state.
    assert.equal(output.branch, "task-1");
    assert.ok(existsSync(output.worktree));
    assert.doesNotThrow(() => git(root, "rev-parse", "--verify", "refs/heads/task-1"));
    const leaseOwner = JSON.parse(readFileSync(taskWorktreeLeasePath(output.worktree), "utf8"));
    assert.equal(leaseOwner.runId, "run-a");
    assert.ok(!existsSync(journalPath));
    const state = readTaskRunState(1, root);
    assert.equal(state.worktree, output.worktree);
    assert.equal(state.leaseRunId, "run-a");
});

// F1: fault injection for a retained journal whose named run is no longer the physical lease
// owner - a live third owner now legitimately holds it and must never be touched.
test("test_createTaskWorktree_refusesARetainedJournalWhenAThirdOwnerHoldsThePhysicalLease", () => {
    // Setup: a completed creation under run-a, then a journal is hand-written back naming run-a
    // (simulating a retained journal), and the physical lease is separately overwritten to name
    // run-c (a live third owner). Before the fix, createTaskWorktree would blindly overwrite the
    // retained journal with a new one naming the CALLING run before it ever inspected the lease -
    // corrupting the exact ownership record Phase 8 reconciliation depends on - even though its
    // own EEXIST-triggered rollback happens to also refuse to touch run-c's worktree here.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);
    createTaskWorktree(1, "run-a", root);
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    const journalPath = taskWorktreeCreateJournalPath(expectedWorktree);
    writeFileSync(journalPath, JSON.stringify({
        taskNumber: 1, runId: "run-a", worktreePath: expectedWorktree, branch: "task-1",
        createdAt: "2026-01-01T00:00:00+00:00",
    }));
    writeFileSync(taskWorktreeLeasePath(expectedWorktree), JSON.stringify({ runId: "run-c", pid: 1, createdAt: 1 }));

    // Test action + verification: a call under a different run refuses rather than touching run-c's worktree.
    assert.throws(() => createTaskWorktree(1, "run-b", root));

    // Verification: run-c's lease, the worktree, and the branch are all untouched.
    assert.ok(existsSync(expectedWorktree));
    const leaseOwner = JSON.parse(readFileSync(taskWorktreeLeasePath(expectedWorktree), "utf8"));
    assert.equal(leaseOwner.runId, "run-c");
    assert.doesNotThrow(() => git(root, "rev-parse", "--verify", "refs/heads/task-1"));

    // Verification: the journal is retained UNCHANGED - still naming its original run-a, never
    // overwritten with the new caller's identity before the conflict was discovered.
    assert.ok(existsSync(journalPath));
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    assert.equal(journal.runId, "run-a");
});

// Remediation for phase8-9-audit finding 1 / feedback-phase8-1 finding 1: the current call's
// runId was never compared with the retained journal's runId, so a call for run B could consume
// a completed journal for run A and return run A's worktree without ever acquiring ownership for
// run B. Before the fix this test's assert.throws would fail: run-a's completed journal would be
// silently adopted (unlinked and returned) by the call made for run-b.
test("test_createTaskWorktree_refusesARetainedJournalOwnedByADifferentRunWithoutTouchingIt", () => {
    // Setup: task 1's creation genuinely completed under run-a, then a journal is hand-written
    // back to simulate death right before its own unlink - a completed retained journal for run-a.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);
    const created = createTaskWorktree(1, "run-a", root);
    const journalPath = taskWorktreeCreateJournalPath(created.worktree);
    writeFileSync(journalPath, JSON.stringify({
        taskNumber: 1, runId: "run-a", worktreePath: created.worktree, branch: created.branch,
        createdAt: "2026-01-01T00:00:00+00:00",
    }));

    // Test action + verification: a call under run-b must not adopt run-a's completed journal.
    assert.throws(() => createTaskWorktree(1, "run-b", root));

    // Verification: run-a's worktree, branch and lease are all untouched - not returned to run-b
    // and not destroyed.
    assert.ok(existsSync(created.worktree));
    const leaseOwner = JSON.parse(readFileSync(taskWorktreeLeasePath(created.worktree), "utf8"));
    assert.equal(leaseOwner.runId, "run-a");
    assert.doesNotThrow(() => git(root, "rev-parse", "--verify", "refs/heads/task-1"));
    assert.ok(existsSync(journalPath));
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    assert.equal(journal.runId, "run-a");
});

// Remediation for phase8-9-audit finding 1 / feedback-phase8-1 finding 1: task state matching
// the journal was accepted as proof of a finished creation even when the physical lease was
// absent. Before the fix this test's assert.throws would fail: the mismatched state (task state
// says leased, no lease file exists) would be silently treated as a completed creation.
test("test_createTaskWorktree_refusesARetainedJournalWhenTaskStateMatchesButThePhysicalLeaseIsMissing", () => {
    // Setup: a real worktree/branch exist and task state is recorded to match, but the physical
    // lease file is then removed - task state claims a lease that no longer physically exists.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "declared" };
    const worktree = createWorktreeForGroup(root, group, "run-a");
    updateCurrentTaskRun(1, "run-a", { worktree, leaseRunId: "run-a" }, root);
    unlinkSync(taskWorktreeLeasePath(worktree));
    const journalPath = taskWorktreeCreateJournalPath(expectedWorktree);
    writeFileSync(journalPath, JSON.stringify({
        taskNumber: 1, runId: "run-a", worktreePath: expectedWorktree, branch: "task-1",
        createdAt: "2026-01-01T00:00:00+00:00",
    }));

    // Test action + verification: state alone must not be trusted as proof of a finished creation.
    assert.throws(() => createTaskWorktree(1, "run-a", root));

    // Verification: nothing is destroyed - the worktree and branch task state still claims are
    // leased are left exactly as found, and the journal is retained.
    assert.ok(existsSync(worktree));
    assert.doesNotThrow(() => git(root, "rev-parse", "--verify", "refs/heads/task-1"));
    assert.ok(existsSync(journalPath));
});
