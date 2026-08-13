// Behavioral checks for createTaskWorktree.ts. Run alone: node --test tests/tackle-tasks/createTaskWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskWorktree, taskBranchName, taskWorktreeCreateJournalPath } from "../../scripts/tackle-tasks/createTaskWorktree.ts";
import { claimTask, readTaskRunState } from "../../scripts/tackle-tasks/taskRunState.ts";
import { resolveTaskWorktreeConventionDirectory, taskWorktreeLeasePath } from "../../scripts/prepareTasks.ts";

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
