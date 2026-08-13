// Behavioral checks for taskRunState.ts, the only module that reads/writes task.run.
// Run alone: node --test tests/tackle-tasks/taskRunState.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    adoptWorktreeLease,
    appendTaskCommits,
    claimTask,
    endTaskRun,
    getCurrentTaskRun,
    readTaskRunState,
    replaceEndedRunOutcome,
    updateCurrentTaskRun,
    type TaskRunRecord,
} from "../../scripts/tackle-tasks/taskRunState.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "taskRunState-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function readTasksFile(root: string): any[] {
    const { tasksPath } = resolveTaskFiles(root);
    return JSON.parse(readFileSync(tasksPath, "utf8"));
}

function endedRunRecord(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
        runId: "run-old", startedAt: "2026-08-01T00:00:00-07:00", endedAt: "2026-08-01T00:05:00-07:00",
        exitType: "completed", exitNote: null, modifiedFiles: [], commits: [],
        implementationNotesFile: null, taskTests: null, fullSuite: null,
        ...overrides,
    };
}

test("test_readTaskRunState_returnsEmptyHistoryWhenTaskHasNoRunKey", () => {
    // Scenario: a task record predates the run field entirely.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    // Reading its run state must not throw and must report an empty, inactive state.
    const state = readTaskRunState(1, root);
    assert.deepEqual(state, { active: false, worktree: null, leaseRunId: null, history: [] });
});

test("test_claimTask_appendsARecordWithAStartTimestampAndNoEndTimestamp", () => {
    // Scenario: claiming an open task with no prior run history.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    // Claim the task with a fresh runId.
    const outcome = claimTask(1, "run-a", root);
    // The claim succeeds and appends exactly one record, started but not ended.
    assert.equal(outcome.status, "claimed");
    if (outcome.status !== "claimed") return;
    assert.equal(outcome.state.history.length, 1);
    assert.equal(outcome.state.history[0].runId, "run-a");
    assert.equal(outcome.state.history[0].endedAt, null);
    assert.match(outcome.state.history[0].startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test("test_claimTask_returnsRefusedRatherThanThrowingWhenTheTaskIsActive", () => {
    // Scenario: a task already has a live run when a second caller tries to claim it.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [endedRunRecord({ runId: "run-holder", endedAt: null, exitType: null })] },
    }]);
    // A second caller tries to claim the same task.
    const outcome = claimTask(1, "run-b", root);
    // The call returns refused, naming the run that holds it, instead of throwing.
    assert.deepEqual(outcome, { status: "refused", heldByRunId: "run-holder" });
});

test("test_claimTask_refusesATaskWhoseNewestRunCompletedButIsStillOpen", () => {
    // Scenario: the previous run finished successfully but archiving has not landed yet (rule 12).
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history: [endedRunRecord({ runId: "run-old", exitType: "completed" })] },
    }]);
    // A new claim attempt during that closing window.
    const outcome = claimTask(1, "run-c", root);
    // It is refused as "closing", distinct from an ordinary refusal.
    assert.deepEqual(outcome, { status: "closing" });
});

test("test_claimTask_isAtomicUnderConcurrentCallers", async () => {
    // Scenario: many separate processes race to claim the same open task.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "..", "scripts", "tackle-tasks", "taskRunState.ts")).href;
    const startFile = join(root, "start");
    const resultsDir = mkdtempSync(join(tmpdir(), "taskRunState-results-"));
    const childCount = 12;
    const children = Array.from({ length: childCount }, (_, index) => {
        const resultFile = join(resultsDir, `${index}.json`);
        const childSource = `
            import { existsSync, writeFileSync } from "node:fs";
            import { claimTask } from ${JSON.stringify(moduleUrl)};
            const wait = new Int32Array(new SharedArrayBuffer(4));
            while (!existsSync(${JSON.stringify(startFile)})) Atomics.wait(wait, 0, 0, 5);
            const outcome = claimTask(1, ${JSON.stringify(`run-${index}`)}, ${JSON.stringify(root)});
            writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(outcome));
        `;
        return spawn(process.execPath, ["--input-type=module", "--eval", childSource], { stdio: "inherit" });
    });
    const exits = children.map((child) => once(child, "exit"));
    writeFileSync(startFile, "go\n");
    for (const [code, signal] of await Promise.all(exits)) {
        assert.equal(signal, null);
        assert.equal(code, 0);
    }
    // Read back every child's outcome: exactly one claimed, the rest refused.
    const outcomes = Array.from({ length: childCount }, (_, index) =>
        JSON.parse(readFileSync(join(resultsDir, `${index}.json`), "utf8")));
    const claimed = outcomes.filter((outcome) => outcome.status === "claimed");
    assert.equal(claimed.length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "refused").length, childCount - 1);
    // The task file itself must also reflect exactly one appended run.
    const state = readTaskRunState(1, root);
    assert.equal(state.history.length, 1);
});

test("test_claimTask_keepsEveryEarlierRunInHistory", () => {
    // Scenario: a task has one ended, non-completed run and is claimed again.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history: [endedRunRecord({ runId: "run-old", exitType: "run-failed" })] },
    }]);
    // Claim the task again with a new runId.
    const outcome = claimTask(1, "run-new", root);
    // Both the old and new records survive, oldest first.
    assert.equal(outcome.status, "claimed");
    if (outcome.status !== "claimed") return;
    assert.equal(outcome.state.history.length, 2);
    assert.equal(outcome.state.history[0].runId, "run-old");
    assert.equal(outcome.state.history[1].runId, "run-new");
});

test("test_updateCurrentTaskRun_mergesOnlyTheGivenFields", () => {
    // Scenario: an active run needs one field updated without disturbing the rest of the record.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Update only implementationNotesFile.
    const state = updateCurrentTaskRun(1, { implementationNotesFile: "notes.md" }, root);
    // That field changed; everything else on the record is untouched.
    const record = state.history[state.history.length - 1];
    assert.equal(record.implementationNotesFile, "notes.md");
    assert.equal(record.runId, "run-a");
    assert.deepEqual(record.modifiedFiles, []);
    assert.equal(record.exitType, null);
});

test("test_updateCurrentTaskRun_throwsWhenNoRunIsActive", () => {
    // Scenario: no run is active for the task.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    // Calling update without a prior claim must throw, not silently no-op.
    assert.throws(() => updateCurrentTaskRun(1, { implementationNotesFile: "notes.md" }, root));
});

test("test_appendTaskCommits_neverOverwritesEarlierCommits", () => {
    // Scenario: commits are appended across two separate calls during one run.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    appendTaskCommits(1, [{ occurrenceId: "", hash: "aaa", kind: "work" }], root);
    // Append a second batch of commits.
    const state = appendTaskCommits(1, [{ occurrenceId: "", hash: "bbb", kind: "repair" }], root);
    // Both commits remain, in the order they were appended.
    const record = state.history[state.history.length - 1];
    assert.deepEqual(record.commits, [
        { occurrenceId: "", hash: "aaa", kind: "work" },
        { occurrenceId: "", hash: "bbb", kind: "repair" },
    ]);
});

test("test_endTaskRun_stampsEndedAtAndClearsActive", () => {
    // Scenario: an active run finishes.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // End the run.
    const state = endTaskRun(1, root);
    // The state is no longer active and the record now has an end timestamp.
    assert.equal(state.active, false);
    assert.notEqual(state.history[state.history.length - 1].endedAt, null);
});

test("test_replaceEndedRunOutcome_overwritesCompletedWithRunFailedInOneWrite", () => {
    // Scenario: a failure happens after "mark task inactive" on the success tail (rule 10, case four).
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history: [endedRunRecord({ runId: "run-a", exitType: "completed" })] },
    }]);
    // Reopen the outcome and overwrite it.
    const state = replaceEndedRunOutcome(1, "run-failed", "clean-up crashed", root);
    // The newest record's exit type and note are overwritten, and its endedAt is re-stamped.
    const record = state.history[state.history.length - 1];
    assert.equal(record.exitType, "run-failed");
    assert.equal(record.exitNote, "clean-up crashed");
    assert.notEqual(record.endedAt, "2026-08-01T00:05:00-07:00");
});

test("test_replaceEndedRunOutcome_neverLeavesTheRunActive", () => {
    // Scenario: same reopen transition as above.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history: [endedRunRecord({ runId: "run-a", exitType: "completed" })] },
    }]);
    // Replace the outcome.
    const state = replaceEndedRunOutcome(1, "run-failed", "clean-up crashed", root);
    // The returned state, and the file on disk, both show the run as inactive throughout.
    assert.equal(state.active, false);
    const onDisk = readTasksFile(root)[0].run;
    assert.equal(onDisk.active, false);
});

test("test_adoptWorktreeLease_transfersAnEndedRunsLease", () => {
    // Scenario: a resumed run's claim owns the task, and the worktree lease still names the previous, ended run.
    const root = mkdtempSync(join(tmpdir(), "taskRunState-"));
    const worktreePath = join(root, "worktree");
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: {
            active: true, worktree: worktreePath, leaseRunId: "run-old",
            history: [
                endedRunRecord({ runId: "run-old", exitType: "run-failed" }),
                { runId: "run-new", startedAt: "2026-08-02T00:00:00-07:00", endedAt: null, exitType: null, exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null },
            ],
        },
    }], null, 2));
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    // Adopt the lease into the resumed run.
    const result = adoptWorktreeLease(1, "run-new", root);
    // Adoption succeeds, and both task.run and the sibling lease file now name the new run.
    assert.equal(result.adopted, true);
    const state = readTaskRunState(1, root);
    assert.equal(state.leaseRunId, "run-new");
    const leaseFile = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(leaseFile.runId, "run-new");
});

test("test_adoptWorktreeLease_refusesWhileTheOwningRunIsStillActive", () => {
    // Scenario: the lease's owning run has not ended, so the worktree is still legitimately in use.
    const root = mkdtempSync(join(tmpdir(), "taskRunState-"));
    const worktreePath = join(root, "worktree");
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: {
            active: true, worktree: worktreePath, leaseRunId: "run-a",
            history: [{ runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null, exitType: null, exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null }],
        },
    }], null, 2));
    // Attempt to adopt the lease for the same run that already holds it.
    const result = adoptWorktreeLease(1, "run-a", root);
    // Adoption is refused because the owning run has not ended.
    assert.equal(result.adopted, false);
});

test("test_updateCurrentTaskRun_leavesOtherTasksByteIdentical", () => {
    // Scenario: two tasks exist; only one has an active run being updated.
    const root = makeProjectRootWithTasks([
        { taskNumber: 1, title: "t1" },
        { taskNumber: 2, title: "t2", description: "untouched", nested: { keep: [1, 2, 3] } },
    ]);
    claimTask(1, "run-a", root);
    const { tasksPath } = resolveTaskFiles(root);
    const beforeTasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    const task2Before = JSON.stringify(beforeTasks[1]);
    // Update task 1's active run.
    updateCurrentTaskRun(1, { implementationNotesFile: "notes.md" }, root);
    // Task 2's record is byte-for-byte identical to before.
    const afterTasks = JSON.parse(readFileSync(tasksPath, "utf8"));
    const task2After = JSON.stringify(afterTasks[1]);
    assert.equal(task2After, task2Before);
});

test("test_updateCurrentTaskRun_holdsTheTaskStateLockWhileWriting", async () => {
    // Scenario: a separate process holds the task-state lock while updateCurrentTaskRun tries to write.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t1" }]);
    claimTask(1, "run-a", root);
    const { tasksPath } = resolveTaskFiles(root);
    const lockPath = join(root, "task-state.lock");
    const holdMs = 300;
    // This process takes the lock first, so the hold is a fact rather than a race the child might lose.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: "wx" });
    // The child only releases it, after the hold window.
    const childSource = `
        import { unlinkSync } from "node:fs";
        const wait = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(wait, 0, 0, ${holdMs});
        unlinkSync(${JSON.stringify(lockPath)});
    `;
    const start = Date.now();
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], { stdio: "inherit" });
    // Write while the lock is externally held.
    updateCurrentTaskRun(1, { implementationNotesFile: "notes.md" }, root);
    const elapsed = Date.now() - start;
    await once(child, "exit");
    // The write only completed after the external holder released the lock, proving it waited.
    assert.ok(elapsed >= holdMs, `expected updateCurrentTaskRun to wait for the lock, took ${elapsed}ms`);
    void tasksPath;
});

// --- Finding 6: the empty run state must never be a shared mutable object. ---

test("test_readTaskRunState_returnsAFreshEmptyHistoryEveryCallSoMutationCannotLeak", () => {
    // Scenario: two legacy tasks with no run key at all.
    const root = makeProjectRootWithTasks([
        { taskNumber: 1, title: "t1" },
        { taskNumber: 2, title: "t2" },
    ]);
    // Read task 1's empty state and mutate the history array a caller should never keep.
    const firstRead = readTaskRunState(1, root);
    firstRead.history.push({
        runId: "contaminant", startedAt: "x", endedAt: null, exitType: null, exitNote: null,
        modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
    });
    // Fresh reads of both task 1 and task 2 must still be empty.
    assert.deepEqual(readTaskRunState(1, root).history, []);
    assert.deepEqual(readTaskRunState(2, root).history, []);
    // Claiming task 1 must persist exactly one new record, not the contaminant plus one.
    const outcome = claimTask(1, "run-a", root);
    assert.equal(outcome.status, "claimed");
    if (outcome.status !== "claimed") return;
    assert.equal(outcome.state.history.length, 1);
    assert.equal(outcome.state.history[0].runId, "run-a");
});

// --- Finding 7: replaceEndedRunOutcome must enforce its ended-completed-run contract. ---

test("test_replaceEndedRunOutcome_throwsAndLeavesBytesUnchangedWhenTheRunIsActive", () => {
    // Scenario: a caller wrongly targets a run that is still active.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: {
            active: true, worktree: null, leaseRunId: null,
            history: [{
                runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null, exitType: null,
                exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null,
                taskTests: null, fullSuite: null,
            }],
        },
    }]);
    const { tasksPath } = resolveTaskFiles(root);
    const bytesBefore = readFileSync(tasksPath, "utf8");
    // The call must throw rather than silently terminating the active run.
    assert.throws(() => replaceEndedRunOutcome(1, "run-failed", "note", root));
    assert.equal(readFileSync(tasksPath, "utf8"), bytesBefore);
});

test("test_replaceEndedRunOutcome_throwsAndLeavesBytesUnchangedWhenTheEndedRunDidNotComplete", () => {
    // Scenario: the newest run ended, but not with exitType "completed".
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history: [endedRunRecord({ runId: "run-a", exitType: "tests-red" })] },
    }]);
    const { tasksPath } = resolveTaskFiles(root);
    const bytesBefore = readFileSync(tasksPath, "utf8");
    // Only rule 10's fourth case (an ended, completed run) may be reopened.
    assert.throws(() => replaceEndedRunOutcome(1, "run-failed", "note", root));
    assert.equal(readFileSync(tasksPath, "utf8"), bytesBefore);
});

// --- Finding 5: worktree-lease adoption must never split-brain tasks.json and the lease file. ---

function makeAdoptionFixture(): { root: string; worktreePath: string; leasePath: string } {
    const root = mkdtempSync(join(tmpdir(), "taskRunState-"));
    const worktreePath = join(root, "worktree");
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: {
            active: true, worktree: worktreePath, leaseRunId: "run-old",
            history: [
                endedRunRecord({ runId: "run-old", exitType: "run-failed" }),
                {
                    runId: "run-new", startedAt: "2026-08-02T00:00:00-07:00", endedAt: null, exitType: null,
                    exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null,
                    taskTests: null, fullSuite: null,
                },
            ],
        },
    }], null, 2));
    return { root, worktreePath, leasePath: `${worktreePath}.lease` };
}

test("test_adoptWorktreeLease_refusesWhenTheOnDiskLeaseOwnerDoesNotMatchTheExpectedStaleOwner", () => {
    // Scenario: tasks.json says the lease is held by "run-old", but the file on disk names someone else.
    const { root, worktreePath, leasePath } = makeAdoptionFixture();
    writeFileSync(leasePath, JSON.stringify({ runId: "run-someone-else", pid: 1, createdAt: 1 }));
    const before = readFileSync(leasePath, "utf8");
    const tasksBefore = readFileSync(join(root, "tasks.json"), "utf8");
    // Adoption must refuse rather than steal the lease from its real owner.
    const result = adoptWorktreeLease(1, "run-new", root);
    assert.equal(result.adopted, false);
    assert.equal(readFileSync(leasePath, "utf8"), before);
    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksBefore);
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), false);
});

test("test_adoptWorktreeLease_refusesWhenTheLeaseFileIsMissing", () => {
    // Scenario: no sibling lease file exists at all.
    const { root, worktreePath } = makeAdoptionFixture();
    const tasksBefore = readFileSync(join(root, "tasks.json"), "utf8");
    const result = adoptWorktreeLease(1, "run-new", root);
    assert.equal(result.adopted, false);
    assert.equal(existsSync(`${worktreePath}.lease`), false);
    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksBefore);
});

test("test_adoptWorktreeLease_refusesWhenTheLeaseFileIsMalformed", () => {
    // Scenario: the sibling lease file exists but is not valid JSON.
    const { root, worktreePath, leasePath } = makeAdoptionFixture();
    writeFileSync(leasePath, "{ not json");
    const before = readFileSync(leasePath, "utf8");
    const tasksBefore = readFileSync(join(root, "tasks.json"), "utf8");
    const result = adoptWorktreeLease(1, "run-new", root);
    assert.equal(result.adopted, false);
    assert.equal(readFileSync(leasePath, "utf8"), before);
    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksBefore);
    void worktreePath;
});

test("test_adoptWorktreeLease_injectedLeaseReplacementFailureLeavesTasksJsonOnTheOldOwner", () => {
    // Scenario: writing the replacement lease fails after the journal is written.
    const { root, leasePath } = makeAdoptionFixture();
    writeFileSync(leasePath, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    process.env.TASKRUNSTATE_TEST_ADOPT_FAIL_AT = "lease";
    try {
        assert.throws(() => adoptWorktreeLease(1, "run-new", root));
    } finally {
        delete process.env.TASKRUNSTATE_TEST_ADOPT_FAIL_AT;
    }
    // The lease still names the old owner and tasks.json was never touched.
    assert.equal(JSON.parse(readFileSync(leasePath, "utf8")).runId, "run-old");
    const onDisk = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))[0].run;
    assert.equal(onDisk.leaseRunId, "run-old");
    assert.equal(existsSync(`${leasePath}.adopt-intent`), false);
});

test("test_adoptWorktreeLease_injectedTaskStateWriteFailureRestoresTheExactOldLeaseBytesAndRetainsNoJournal", () => {
    // Scenario: the lease was already replaced when writing tasks.json fails.
    const { root, worktreePath, leasePath } = makeAdoptionFixture();
    const oldLeaseBytes = JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 });
    writeFileSync(leasePath, oldLeaseBytes);
    process.env.TASKRUNSTATE_TEST_ADOPT_FAIL_AT = "state";
    try {
        assert.throws(() => adoptWorktreeLease(1, "run-new", root));
    } finally {
        delete process.env.TASKRUNSTATE_TEST_ADOPT_FAIL_AT;
    }
    // The lease is restored byte-for-byte and the journal is gone.
    assert.equal(readFileSync(leasePath, "utf8"), oldLeaseBytes);
    const onDisk = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))[0].run;
    assert.equal(onDisk.leaseRunId, "run-old");
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), false);
});

async function runAdoptionInChildAndKillAfter(
    root: string,
    step: "intent" | "lease" | "state",
): Promise<void> {
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "..", "scripts", "tackle-tasks", "taskRunState.ts")).href;
    const childSource = `
        import { adoptWorktreeLease } from ${JSON.stringify(moduleUrl)};
        adoptWorktreeLease(1, "run-new", ${JSON.stringify(root)});
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
        stdio: "inherit",
        env: { ...process.env, TASKRUNSTATE_TEST_ADOPT_KILL_AFTER: step },
    });
    const [, signal] = await once(child, "exit");
    assert.equal(signal, "SIGKILL", `expected the child to die of SIGKILL after step "${step}"`);
    // ponytail: the lock/guard files a killed process leaves behind are a separate, already
    // documented recovery concern (rule 9's explicit-recovery stance), not this finding's
    // split-brain. Clear them the way a supervisor already would, then let the next lease
    // operation reconcile the intent/lease/tasks.json split this finding is about.
    for (const staleLock of [join(root, "task-state.lock"), `${join(root, "worktree")}.lease.guard`]) {
        if (existsSync(staleLock)) unlinkSync(staleLock);
    }
}

test("test_adoptWorktreeLease_reconcilesToOneOwnerAfterAChildIsKilledRightAfterWritingTheIntent", async () => {
    // Scenario: the process dies right after journaling the adoption intent, before any mutation.
    const { root, worktreePath, leasePath } = makeAdoptionFixture();
    writeFileSync(leasePath, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    await runAdoptionInChildAndKillAfter(root, "intent");
    // The next lease operation finishes the adoption instead of leaving a split.
    const result = adoptWorktreeLease(1, "run-new", root);
    assert.equal(JSON.parse(readFileSync(leasePath, "utf8")).runId, "run-new");
    const onDisk = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))[0].run;
    assert.equal(onDisk.leaseRunId, "run-new");
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), false);
    void result;
});

test("test_adoptWorktreeLease_reconcilesToOneOwnerAfterAChildIsKilledRightAfterReplacingTheLease", async () => {
    // Scenario: the process dies after the lease already names the new owner but before tasks.json does.
    const { root, worktreePath, leasePath } = makeAdoptionFixture();
    writeFileSync(leasePath, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    await runAdoptionInChildAndKillAfter(root, "lease");
    adoptWorktreeLease(1, "run-new", root);
    assert.equal(JSON.parse(readFileSync(leasePath, "utf8")).runId, "run-new");
    const onDisk = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))[0].run;
    assert.equal(onDisk.leaseRunId, "run-new");
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), false);
});

test("test_adoptWorktreeLease_reconcilesToOneOwnerAfterAChildIsKilledRightAfterUpdatingTaskState", async () => {
    // Scenario: the process dies after both authorities already agree, but before the journal is deleted.
    const { root, worktreePath, leasePath } = makeAdoptionFixture();
    writeFileSync(leasePath, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    await runAdoptionInChildAndKillAfter(root, "state");
    adoptWorktreeLease(1, "run-new", root);
    assert.equal(JSON.parse(readFileSync(leasePath, "utf8")).runId, "run-new");
    const onDisk = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))[0].run;
    assert.equal(onDisk.leaseRunId, "run-new");
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), false);
});
