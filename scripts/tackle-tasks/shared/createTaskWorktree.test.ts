// Behavioral checks for createTaskWorktree.ts. Run alone: node --test tests/createTaskWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTaskWorktree, taskBranchName, taskWorktreeCreateJournalPath } from "./createTaskWorktree.ts";
import { claimTask, readTaskRunState, updateCurrentTaskRun } from "./taskRunState.ts";
import {
    createWorktreeForGroup, releaseTaskWorktreeLease, resolveTaskWorktreeConventionDirectory, taskWorktreeLeasePath,
} from "../../shared/prepareTasks.ts";
import type { TaskGroup } from "../../shared/taskGroups.ts";

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

function makeProjectRootWithCommit(): string {
    const root = mkdtempSync(join(tmpdir(), "createTaskWorktree-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "fileA.txt"), "root file\n");
    git(root, "add", "fileA.txt");
    git(root, "commit", "-q", "-m", "seed");
    return root;
}

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_createTaskWorktree_createsARealWorktreeOnTheTasksBranchWithSubmodulesPopulated", () => {
    // Setup: a real repo with a real submodule, and an active claimed run for task 1.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: ["fileA.txt"] }]);
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

test("test_createTaskWorktree_populatesASubmoduleWhoseGitlinkTheRemoteDoesNotHaveYet", () => {
    // Setup: vendor gains a nested submodule; both hold an unpushed commit that the gitlinks name.
    const { root, submoduleOrigin } = makeProjectRootWithLocalSubmodule();
    const vendor = join(root, "vendor");
    git(vendor, "config", "user.email", "test@example.com");
    git(vendor, "config", "user.name", "Test");
    const innerOrigin = mkdtempSync(join(tmpdir(), "createTaskWorktree-inner-"));
    git(innerOrigin, "init", "-q");
    git(innerOrigin, "config", "user.email", "test@example.com");
    git(innerOrigin, "config", "user.name", "Test");
    git(innerOrigin, "commit", "-q", "--allow-empty", "-m", "seed");
    git(vendor, "submodule", "add", "-q", innerOrigin, "inner");
    git(vendor, "commit", "-q", "-m", "add inner");
    const inner = join(vendor, "inner");
    git(inner, "config", "user.email", "test@example.com");
    git(inner, "config", "user.name", "Test");
    git(inner, "commit", "-q", "--allow-empty", "-m", "inner unpushed");
    git(vendor, "add", "inner");
    git(vendor, "commit", "-q", "-m", "vendor unpushed: bump inner gitlink");
    git(root, "add", "vendor");
    git(root, "commit", "-q", "-m", "bump vendor gitlink to unpushed commit");
    const vendorGitlink = git(root, "rev-parse", "HEAD:vendor").trim();
    const innerGitlink = git(vendor, "rev-parse", "HEAD:inner").trim();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: ["fileA.txt"] }]);
    claimTask(1, "run-a", root);

    // Test action: create the task worktree.
    const output = createTaskWorktree(1, "run-a", root);

    // Verification: both submodules sit on their unpushed commits and still name their real remotes.
    assert.equal(git(join(output.worktree, "vendor"), "rev-parse", "HEAD").trim(), vendorGitlink);
    assert.equal(git(join(output.worktree, "vendor", "inner"), "rev-parse", "HEAD").trim(), innerGitlink);
    assert.equal(git(join(output.worktree, "vendor"), "remote", "get-url", "origin").trim(), submoduleOrigin);
    assert.equal(git(join(output.worktree, "vendor", "inner"), "remote", "get-url", "origin").trim(), innerOrigin);
});

test("test_createTaskWorktree_recordsTheWorktreePathOnTheActiveRun", () => {
    // Setup: a real repo, an active claimed run.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
    claimTask(1, "run-a", root);

    // Test action: create the worktree.
    const output = createTaskWorktree(1, "run-a", root);

    // Verification: the run state's worktree and leaseRunId reflect the new worktree.
    const state = readTaskRunState(1, root);
    assert.equal(state.worktree, output.worktree);
    assert.equal(state.leaseRunId, "run-a");
});

test("test_createTaskWorktree_rollsBackTheWorktreeAndLeaseWhenTaskStateRecordingFails", () => {
    // Setup: run-a is claimed, but createTaskWorktree runs with unrelated run-b, so expectedRunId check fails after worktree and lease exist.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
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
    // Setup: same task-state mismatch as above, but rollback's worktree/branch removal is sabotaged, simulating a real git worktree remove failure.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
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
    // Setup: same mismatch, but another owner takes the lease before rollback re-reads it (F11: old code deleted its worktree).
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
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
    // Setup: a real repo and submodule, with submodule objects broken so `git worktree add` succeeds but submodule-init fails afterward.
    const { root, submoduleOrigin } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
    claimTask(1, "run-a", root);
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    rmSync(join(root, ".git", "modules", "vendor"), { recursive: true, force: true });
    rmSync(submoduleOrigin, { recursive: true, force: true });

    // Test action + verification: the broken submodule init throws.
    assert.throws(() => createTaskWorktree(1, "run-a", root));

    // Verification: same full-rollback contract as a task-state recording failure — nothing this attempt created (worktree, branch, lease, journal) survives.
    assert.ok(!existsSync(expectedWorktree));
    assert.ok(!existsSync(taskWorktreeLeasePath(expectedWorktree)));
    assert.ok(!existsSync(taskWorktreeCreateJournalPath(expectedWorktree)));
    assert.throws(() => git(root, "rev-parse", "--verify", "refs/heads/task-1"));
    const state = readTaskRunState(1, root);
    assert.equal(state.worktree, null);
    assert.equal(state.leaseRunId, null);
});

// F1: fault injection for a journal retained after task state was written but before it was deleted (creation finished).
test("test_createTaskWorktree_recoversALateCompletedJournalWithoutTouchingTheGoodWorktree", () => {
    // Setup: a real worktree/lease and finished task state exist; a journal is hand-written to simulate death before its unlink.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
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

// F1: fault injection - journal retained after a call died with worktree/branch/lease created but before task state was written.
test("test_createTaskWorktree_recoversARetainedJournalWithNoTaskStateRecordedYet", () => {
    // Setup: a real worktree/lease and matching journal exist, but updateCurrentTaskRun never ran, so task.run.worktree is still null.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
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

// F1: fault injection - retained journal's run no longer owns the lease; a live third owner now holds it.
test("test_createTaskWorktree_refusesARetainedJournalWhenAThirdOwnerHoldsThePhysicalLease", () => {
    // Setup: a completed run-a creation, a journal hand-written naming run-a, and the lease separately overwritten to name run-c.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
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

    // Verification: the journal stays unchanged, still naming run-a, never overwritten with the caller's identity before the conflict was found.
    assert.ok(existsSync(journalPath));
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    assert.equal(journal.runId, "run-a");
});

// Remediation for phase8-9-audit/feedback-phase8-1 finding 1: runId was never compared with the journal's runId, letting run-b adopt run-a's completed journal.
test("test_createTaskWorktree_refusesARetainedJournalOwnedByADifferentRunWithoutTouchingIt", () => {
    // Setup: task 1's creation completed under run-a, then a journal is hand-written to simulate death right before its unlink.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
    claimTask(1, "run-a", root);
    const created = createTaskWorktree(1, "run-a", root);
    const journalPath = taskWorktreeCreateJournalPath(created.worktree);
    writeFileSync(journalPath, JSON.stringify({
        taskNumber: 1, runId: "run-a", worktreePath: created.worktree, branch: created.branch,
        createdAt: "2026-01-01T00:00:00+00:00",
    }));

    // Test action + verification: a call under run-b must not adopt run-a's completed journal.
    assert.throws(() => createTaskWorktree(1, "run-b", root));

    // Verification: run-a's worktree, branch and lease are all untouched - not returned to run-b and not destroyed.
    assert.ok(existsSync(created.worktree));
    const leaseOwner = JSON.parse(readFileSync(taskWorktreeLeasePath(created.worktree), "utf8"));
    assert.equal(leaseOwner.runId, "run-a");
    assert.doesNotThrow(() => git(root, "rev-parse", "--verify", "refs/heads/task-1"));
    assert.ok(existsSync(journalPath));
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    assert.equal(journal.runId, "run-a");
});

// Remediation for phase8-9-audit/feedback-phase8-1 finding 1: matching task state was wrongly accepted as proof of completion even without a lease.
test("test_createTaskWorktree_refusesARetainedJournalWhenTaskStateMatchesButThePhysicalLeaseIsMissing", () => {
    // Setup: a real worktree/branch and matching task state exist, but the lease file is then removed.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
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

    // Verification: the worktree and branch task state calls leased are left untouched, and the journal is retained.
    assert.ok(existsSync(worktree));
    assert.doesNotThrow(() => git(root, "rev-parse", "--verify", "refs/heads/task-1"));
    assert.ok(existsSync(journalPath));
});

// Task 24 (PRE-12): kills a real child process after the named createWorktreeForGroup step, proving recovery against real process death.
async function runCreateTaskWorktreeInChildAndKillAfter(
    root: string,
    taskNumber: number,
    runId: string,
    step: "lease" | "gitCreate" | "gitReset",
): Promise<void> {
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "createTaskWorktree.ts")).href;
    const childSource = `
        import { createTaskWorktree } from ${JSON.stringify(moduleUrl)};
        createTaskWorktree(${taskNumber}, ${JSON.stringify(runId)}, ${JSON.stringify(root)});
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
        stdio: "inherit",
        env: { ...process.env, CREATEWORKTREEFORGROUP_TEST_KILL_AFTER: step },
    });
    const [, signal] = await once(child, "exit");
    assert.equal(signal, "SIGKILL", `expected the child to die of SIGKILL after step "${step}"`);
}

test("test_createTaskWorktree_recoversAfterBeingKilledRightAfterAcquiringTheLease", async () => {
    // Setup: a real repo, an active claimed run, no prior worktree.
    const { root } = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
    claimTask(1, "run-a", root);
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");

    // Test action: kill the child right after it acquires the lease, before any git worktree exists.
    await runCreateTaskWorktreeInChildAndKillAfter(root, 1, "run-a", "lease");

    // Verification: the lease survived the kill, naming this run; no git worktree exists yet.
    const leaseOwner = JSON.parse(readFileSync(taskWorktreeLeasePath(expectedWorktree), "utf8"));
    assert.equal(leaseOwner.runId, "run-a");
    assert.ok(!existsSync(expectedWorktree));

    // Test action: retry in-process.
    const output = createTaskWorktree(1, "run-a", root);

    // Verification: a real worktree now exists on task-1, and no journal remains.
    assert.equal(output.branch, "task-1");
    assert.ok(existsSync(output.worktree));
    assert.ok(!existsSync(taskWorktreeCreateJournalPath(output.worktree)));
});

test("test_createTaskWorktree_recoversAfterBeingKilledRightAfterResettingAnExistingBranch", async () => {
    // Setup: a leftover worktree directory a previous run left behind after its lease was cleanly released.
    const root = makeProjectRootWithCommit();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
    const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(root), "task-1");
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "declared" };
    createWorktreeForGroup(root, group, "run-a");
    releaseTaskWorktreeLease({ worktreePath: expectedWorktree, runId: "run-a" });
    claimTask(1, "run-b", root);

    // Test action: kill the child right after it resets the existing branch.
    await runCreateTaskWorktreeInChildAndKillAfter(root, 1, "run-b", "gitReset");

    // Verification: the lease and create-journal both survived the kill, naming this run.
    const leaseOwner = JSON.parse(readFileSync(taskWorktreeLeasePath(expectedWorktree), "utf8"));
    assert.equal(leaseOwner.runId, "run-b");
    const journal = JSON.parse(readFileSync(taskWorktreeCreateJournalPath(expectedWorktree), "utf8"));
    assert.equal(journal.runId, "run-b");

    // Test action: retry in-process.
    const output = createTaskWorktree(1, "run-b", root);

    // Verification: creation completes on task-1, task state records run-b, no journal remains.
    assert.equal(output.branch, "task-1");
    const state = readTaskRunState(1, root);
    assert.equal(state.leaseRunId, "run-b");
    assert.ok(!existsSync(taskWorktreeCreateJournalPath(output.worktree)));
});

async function runCreateTaskWorktreeInChildAndKillAfterOwnStep(
    root: string,
    taskNumber: number,
    runId: string,
    step: "state" | "isolation",
): Promise<void> {
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "createTaskWorktree.ts")).href;
    const childSource = `
        import { createTaskWorktree } from ${JSON.stringify(moduleUrl)};
        createTaskWorktree(${taskNumber}, ${JSON.stringify(runId)}, ${JSON.stringify(root)});
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
        stdio: "inherit",
        env: { ...process.env, CREATETASKWORKTREE_TEST_KILL_AFTER: step },
    });
    const [, signal] = await once(child, "exit");
    assert.equal(signal, "SIGKILL", `expected the child to die of SIGKILL after step "${step}"`);
}

function isSkipWorktree(worktreePath: string, relativeFile: string): boolean {
    const line = git(worktreePath, "ls-files", "-v", "--", relativeFile);
    return line.startsWith("S");
}

// A tracked plans/brief-*.md so configureGeneratedArtifactIsolation has something real to flag.
function trackABriefFileInRoot(root: string): void {
    mkdirSync(join(root, "plans"), { recursive: true });
    writeFileSync(join(root, "plans", "brief-1.md"), "brief\n");
    git(root, "add", "plans/brief-1.md");
    git(root, "commit", "-q", "-m", "add brief");
}

test("test_createTaskWorktree_recoversAfterBeingKilledRightAfterRecordingTaskState", async () => {
    // Setup: a tracked generated-artifact file so configureGeneratedArtifactIsolation has something to flag.
    const { root } = makeProjectRootWithLocalSubmodule();
    trackABriefFileInRoot(root);
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
    claimTask(1, "run-a", root);

    // Test action: kill right after task state is published, before isolation is configured.
    await runCreateTaskWorktreeInChildAndKillAfterOwnStep(root, 1, "run-a", "state");

    // Verification: task state is published, the journal survives, and isolation is not yet installed.
    const state = readTaskRunState(1, root);
    assert.ok(state.worktree !== null);
    assert.equal(state.leaseRunId, "run-a");
    assert.ok(existsSync(taskWorktreeCreateJournalPath(state.worktree!)));
    assert.equal(isSkipWorktree(state.worktree!, "plans/brief-1.md"), false);

    // Test action: retry in-process.
    const output = createTaskWorktree(1, "run-a", root);

    // Verification: the same worktree is returned, the journal is gone, and isolation is now installed.
    assert.equal(output.worktree, state.worktree);
    assert.ok(!existsSync(taskWorktreeCreateJournalPath(output.worktree)));
    assert.equal(isSkipWorktree(output.worktree, "plans/brief-1.md"), true);
});

test("test_createTaskWorktree_recoversAfterBeingKilledRightAfterConfiguringIsolation", async () => {
    // Setup: same fixture as above.
    const { root } = makeProjectRootWithLocalSubmodule();
    trackABriefFileInRoot(root);
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", modifiableFiles: [] }]);
    claimTask(1, "run-a", root);

    // Test action: kill right after isolation is configured, before the journal is unlinked.
    await runCreateTaskWorktreeInChildAndKillAfterOwnStep(root, 1, "run-a", "isolation");

    // Verification: isolation is installed, but the journal still exists.
    const state = readTaskRunState(1, root);
    assert.equal(isSkipWorktree(state.worktree!, "plans/brief-1.md"), true);
    assert.ok(existsSync(taskWorktreeCreateJournalPath(state.worktree!)));

    // Test action: retry in-process.
    const output = createTaskWorktree(1, "run-a", root);

    // Verification: the journal is gone and isolation remains installed (re-running it is a no-op).
    assert.ok(!existsSync(taskWorktreeCreateJournalPath(output.worktree)));
    assert.equal(isSkipWorktree(output.worktree, "plans/brief-1.md"), true);
});
