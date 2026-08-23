// Behavioral checks for taskRunState.ts, the only module that reads/writes task.run.
// Run alone: node --test tests/taskRunState.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    acquireAbsentWorktreeLease,
    adoptWorktreeLease,
    appendTaskCommits,
    claimTask,
    getAttemptCount,
    raiseAttemptCount,
    MAX_ATTEMPTS,
    endTaskRun,
    getCurrentTaskRun,
    readTaskRunState,
    replaceEndedRunOutcome,
    transitionWorktreeLease,
    updateCurrentTaskRun,
    type TaskRunRecord,
} from "../scripts/tackle-tasks/taskRunState.ts";
import { resolveTaskFiles } from "../scripts/taskFiles.ts";
import { closeTaskRunChecked } from "../scripts/closeTasks.ts";

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
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "scripts", "tackle-tasks", "taskRunState.ts")).href;
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
    const state = updateCurrentTaskRun(1, "run-a", { implementationNotesFile: "notes.md" }, root);
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
    assert.throws(() => updateCurrentTaskRun(1, "run-a", { implementationNotesFile: "notes.md" }, root));
});

test("test_appendTaskCommits_neverOverwritesEarlierCommits", () => {
    // Scenario: commits are appended across two separate calls during one run.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    appendTaskCommits(1, "run-a", [{ occurrenceId: "", hash: "aaa", kind: "work" }], root);
    // Append a second batch of commits.
    const state = appendTaskCommits(1, "run-a", [{ occurrenceId: "", hash: "bbb", kind: "repair" }], root);
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
    const state = endTaskRun(1, "run-a", root);
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
    const state = replaceEndedRunOutcome(1, "run-a", "run-failed", "clean-up crashed", root);
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
    const state = replaceEndedRunOutcome(1, "run-a", "run-failed", "clean-up crashed", root);
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
    updateCurrentTaskRun(1, "run-a", { implementationNotesFile: "notes.md" }, root);
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
    updateCurrentTaskRun(1, "run-a", { implementationNotesFile: "notes.md" }, root);
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
    assert.throws(() => replaceEndedRunOutcome(1, "run-a", "run-failed", "note", root));
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
    assert.throws(() => replaceEndedRunOutcome(1, "run-a", "run-failed", "note", root));
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
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "scripts", "tackle-tasks", "taskRunState.ts")).href;
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

// --- F6: expectedRunId fencing must reject a late writer targeting a run the workflow has
// already ended and replaced. ---

test("test_appendTaskCommits_throwsAndLeavesTheNewerRunUnchangedWhenTargetingAnEndedSiblingRun", () => {
    // Scenario: a paused commit-recording call from an old run wakes up after the workflow
    // ended that run and a later invocation claimed the task.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-old", root);
    endTaskRun(1, "run-old", root);
    claimTask(1, "run-new", root);
    // The delayed call still names the old run; it must fail rather than write into run-new.
    assert.throws(() => appendTaskCommits(1, "run-old", [{ occurrenceId: "", hash: "zzz", kind: "work" }], root));
    // The new run is completely unaffected.
    const state = readTaskRunState(1, root);
    const newest = state.history[state.history.length - 1];
    assert.equal(newest.runId, "run-new");
    assert.deepEqual(newest.commits, []);
});

test("test_updateCurrentTaskRun_throwsAndLeavesTheNewerRunUnchangedWhenTargetingAnEndedSiblingRun", () => {
    // Scenario: a paused task-test recording call wakes up late, after reconciliation moved on.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-old", root);
    endTaskRun(1, "run-old", root);
    claimTask(1, "run-new", root);
    assert.throws(() => updateCurrentTaskRun(1, "run-old", { implementationNotesFile: "stale.md" }, root));
    const state = readTaskRunState(1, root);
    const newest = state.history[state.history.length - 1];
    assert.equal(newest.runId, "run-new");
    assert.equal(newest.implementationNotesFile, null);
});

test("test_endTaskRun_throwsWhenTargetingASiblingRunId", () => {
    // Scenario: a delayed "mark task inactive" call names a run that is not the current one.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-old", root);
    endTaskRun(1, "run-old", root);
    claimTask(1, "run-new", root);
    assert.throws(() => endTaskRun(1, "run-old", root));
    const state = readTaskRunState(1, root);
    assert.equal(state.active, true);
    assert.equal(state.history[state.history.length - 1].runId, "run-new");
});

test("test_replaceEndedRunOutcome_targetsTheRunNamedByExpectedRunIdNotJustWhicheverIsNewest", () => {
    // Scenario: the newest ended run is completed, but a delayed caller supplies a stale run ID.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history: [endedRunRecord({ runId: "run-a", exitType: "completed" })] },
    }]);
    const { tasksPath } = resolveTaskFiles(root);
    const bytesBefore = readFileSync(tasksPath, "utf8");
    // The stale ID does not name the newest record, so the call must throw and change nothing.
    assert.throws(() => replaceEndedRunOutcome(1, "run-stale", "run-failed", "note", root));
    assert.equal(readFileSync(tasksPath, "utf8"), bytesBefore);
});

// --- F6: the checked archive primitive must decide eligibility under the same lock as the write. ---

function makeProjectRootWithTasksAndCompleted(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "taskRunState-close-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    writeFileSync(join(root, "completedTasks.json"), "[]\n");
    return root;
}

test("test_closeTaskRunChecked_archivesACompletedInactiveRunAndDerivesCommitHashesFromIt", () => {
    const root = makeProjectRootWithTasksAndCompleted([{
        taskNumber: 1, title: "t",
        run: {
            active: false, worktree: null, leaseRunId: null,
            history: [endedRunRecord({
                runId: "run-a", exitType: "completed",
                commits: [{ occurrenceId: "", hash: "aaa", kind: "work" }, { occurrenceId: "", hash: "bbb", kind: "merge" }],
            })],
        },
    }]);
    const result = closeTaskRunChecked(1, "run-a", "closure note", root);
    assert.deepEqual(result.closed, [1]);
    const completed = JSON.parse(readFileSync(join(root, "completedTasks.json"), "utf8"));
    assert.deepEqual(completed[0].commitHashes, ["aaa", "bbb"]);
    assert.equal(completed[0].closureNote, "closure note");
});

test("test_closeTaskRunChecked_throwsAndLeavesBothTaskFilesUnchangedForAStaleRunId", () => {
    const root = makeProjectRootWithTasksAndCompleted([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history: [endedRunRecord({ runId: "run-a", exitType: "completed" })] },
    }]);
    const { tasksPath, completedTasksPath } = resolveTaskFiles(root);
    const tasksBefore = readFileSync(tasksPath, "utf8");
    const completedBefore = readFileSync(completedTasksPath, "utf8");
    assert.throws(() => closeTaskRunChecked(1, "run-stale", "note", root));
    assert.equal(readFileSync(tasksPath, "utf8"), tasksBefore);
    assert.equal(readFileSync(completedTasksPath, "utf8"), completedBefore);
});

test("test_closeTaskRunChecked_throwsAndLeavesBothTaskFilesUnchangedForAnActiveRun", () => {
    const root = makeProjectRootWithTasksAndCompleted([{
        taskNumber: 1, title: "t",
        run: {
            active: true, worktree: null, leaseRunId: null,
            history: [{ runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null, exitType: null, exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null }],
        },
    }]);
    const { tasksPath, completedTasksPath } = resolveTaskFiles(root);
    const tasksBefore = readFileSync(tasksPath, "utf8");
    const completedBefore = readFileSync(completedTasksPath, "utf8");
    assert.throws(() => closeTaskRunChecked(1, "run-a", "note", root));
    assert.equal(readFileSync(tasksPath, "utf8"), tasksBefore);
    assert.equal(readFileSync(completedTasksPath, "utf8"), completedBefore);
});

test("test_closeTaskRunChecked_throwsAndLeavesBothTaskFilesUnchangedForANotCompletedRun", () => {
    const root = makeProjectRootWithTasksAndCompleted([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history: [endedRunRecord({ runId: "run-a", exitType: "run-failed" })] },
    }]);
    const { tasksPath, completedTasksPath } = resolveTaskFiles(root);
    const tasksBefore = readFileSync(tasksPath, "utf8");
    const completedBefore = readFileSync(completedTasksPath, "utf8");
    assert.throws(() => closeTaskRunChecked(1, "run-a", "note", root));
    assert.equal(readFileSync(tasksPath, "utf8"), tasksBefore);
    assert.equal(readFileSync(completedTasksPath, "utf8"), completedBefore);
});

// --- F4/F5: one atomic lease transition. ---

test("test_transitionWorktreeLease_refusesOwnerMismatchAndMutatesNothingWhenTaskStateAndThePhysicalLeaseDisagree", () => {
    // Scenario: owner B holds the sibling lease on disk, but tasks.json names owner A.
    const root = mkdtempSync(join(tmpdir(), "taskRunState-"));
    const worktreePath = join(root, "worktree");
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: {
            active: true, worktree: worktreePath, leaseRunId: "run-a",
            history: [{ runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null, exitType: null, exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null }],
        },
    }], null, 2));
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-b", pid: 1, createdAt: 1 }));
    const tasksBefore = readFileSync(join(root, "tasks.json"), "utf8");
    const leaseBefore = readFileSync(`${worktreePath}.lease`, "utf8");
    const outcome = transitionWorktreeLease(1, "run-a", root);
    assert.deepEqual(outcome, { status: "refused-owner-mismatch", heldByRunId: "run-b" });
    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksBefore);
    assert.equal(readFileSync(`${worktreePath}.lease`, "utf8"), leaseBefore);
});

test("test_transitionWorktreeLease_releasesALeaseWhoseOwningRunHasEnded", () => {
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
    const outcome = transitionWorktreeLease(1, "run-new", root);
    assert.deepEqual(outcome, { status: "released" });
    assert.equal(existsSync(`${worktreePath}.lease`), false);
    const state = readTaskRunState(1, root);
    assert.equal(state.leaseRunId, null);
});

test("test_transitionWorktreeLease_reportsAbsentWhenNoLeaseFileExists", () => {
    const root = mkdtempSync(join(tmpdir(), "taskRunState-"));
    const worktreePath = join(root, "worktree");
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: worktreePath, leaseRunId: null, history: [{ runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null, exitType: null, exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null }] },
    }], null, 2));
    const outcome = transitionWorktreeLease(1, "run-a", root);
    assert.deepEqual(outcome, { status: "absent" });
});

// --- F7: atomically acquiring an absent lease for the current claimed run. ---

test("test_acquireAbsentWorktreeLease_acquiresForTheCurrentRunAndUpdatesLeaseRunIdInTheSameTransition", () => {
    const root = mkdtempSync(join(tmpdir(), "taskRunState-"));
    const worktreePath = join(root, "worktree");
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: worktreePath, leaseRunId: null, history: [{ runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null, exitType: null, exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null }] },
    }], null, 2));
    const result = acquireAbsentWorktreeLease(1, "run-a", root);
    assert.deepEqual(result, { acquired: true });
    const state = readTaskRunState(1, root);
    assert.equal(state.leaseRunId, "run-a");
    const leaseFile = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8"));
    assert.equal(leaseFile.runId, "run-a");
});

test("test_acquireAbsentWorktreeLease_refusesWhenALeaseAlreadyExists", () => {
    const root = mkdtempSync(join(tmpdir(), "taskRunState-"));
    const worktreePath = join(root, "worktree");
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: worktreePath, leaseRunId: "run-other", history: [{ runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null, exitType: null, exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null }] },
    }], null, 2));
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "run-other", pid: 1, createdAt: 1 }));
    const before = readFileSync(`${worktreePath}.lease`, "utf8");
    const result = acquireAbsentWorktreeLease(1, "run-a", root);
    assert.deepEqual(result, { acquired: false });
    assert.equal(readFileSync(`${worktreePath}.lease`, "utf8"), before);
});

// --- F7: acquisition must be recoverable across its two durable writes — no split
// lease/state ownership, even across process death, ever survives past the next call. ---

function makeAcquisitionFixture(): { root: string; worktreePath: string; leasePath: string } {
    const root = mkdtempSync(join(tmpdir(), "taskRunState-"));
    const worktreePath = join(root, "worktree");
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: {
            active: true, worktree: worktreePath, leaseRunId: null,
            history: [{
                runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null, exitType: null,
                exitNote: null, modifiedFiles: [], commits: [], implementationNotesFile: null,
                taskTests: null, fullSuite: null,
            }],
        },
    }], null, 2));
    return { root, worktreePath, leasePath: `${worktreePath}.lease` };
}

test("test_acquireAbsentWorktreeLease_injectedTaskStateWriteFailureLeavesNoSplitLeaseAndStateOwnership", () => {
    // Scenario: the physical lease write lands, but the tasks.json write that must follow throws.
    const { root, worktreePath, leasePath } = makeAcquisitionFixture();
    process.env.TASKRUNSTATE_TEST_ADOPT_FAIL_AT = "state";
    try {
        assert.throws(() => acquireAbsentWorktreeLease(1, "run-a", root));
    } finally {
        delete process.env.TASKRUNSTATE_TEST_ADOPT_FAIL_AT;
    }
    // The just-created physical lease was rolled back to absent, matching tasks.json's still-absent leaseRunId.
    assert.equal(existsSync(leasePath), false);
    const onDisk = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))[0].run;
    assert.equal(onDisk.leaseRunId, null);
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), false);
});

test("test_acquireAbsentWorktreeLease_injectedLeaseWriteFailureLeavesNoIntentOrPhysicalLease", () => {
    // Scenario: the failure lands before the physical lease itself is written.
    const { root, worktreePath, leasePath } = makeAcquisitionFixture();
    process.env.TASKRUNSTATE_TEST_ADOPT_FAIL_AT = "lease";
    try {
        assert.throws(() => acquireAbsentWorktreeLease(1, "run-a", root));
    } finally {
        delete process.env.TASKRUNSTATE_TEST_ADOPT_FAIL_AT;
    }
    assert.equal(existsSync(leasePath), false);
    const onDisk = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))[0].run;
    assert.equal(onDisk.leaseRunId, null);
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), false);
});

async function runAcquisitionInChildAndKillAfter(
    root: string,
    step: "intent" | "lease" | "state",
): Promise<void> {
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "scripts", "tackle-tasks", "taskRunState.ts")).href;
    const childSource = `
        import { acquireAbsentWorktreeLease } from ${JSON.stringify(moduleUrl)};
        acquireAbsentWorktreeLease(1, "run-a", ${JSON.stringify(root)});
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
        stdio: "inherit",
        env: { ...process.env, TASKRUNSTATE_TEST_ADOPT_KILL_AFTER: step },
    });
    const [, signal] = await once(child, "exit");
    assert.equal(signal, "SIGKILL", `expected the child to die of SIGKILL after step "${step}"`);
    // ponytail: same already-documented stale-lock cleanup as the adoption kill tests (rule 9's
    // explicit-recovery stance) — not part of this finding's split-brain being proven here.
    for (const staleLock of [join(root, "task-state.lock"), `${join(root, "worktree")}.lease.guard`]) {
        if (existsSync(staleLock)) unlinkSync(staleLock);
    }
}

test("test_acquireAbsentWorktreeLease_reconcilesToOneOwnerWithoutLosingTheWorktreeAfterAChildIsKilledRightAfterWritingThePhysicalLease", async () => {
    // Scenario: the process dies after the physical lease already names the new run, before tasks.json does.
    const { root, worktreePath, leasePath } = makeAcquisitionFixture();
    await runAcquisitionInChildAndKillAfter(root, "lease");
    // A retry, in this separate process, must reach one consistent ownership state.
    const result = acquireAbsentWorktreeLease(1, "run-a", root);
    assert.deepEqual(result, { acquired: true });
    assert.equal(JSON.parse(readFileSync(leasePath, "utf8")).runId, "run-a");
    const onDisk = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))[0].run;
    assert.equal(onDisk.leaseRunId, "run-a");
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), false);
    // The worktree record itself survived reconciliation untouched — the retained work is not lost.
    assert.equal(onDisk.worktree, worktreePath);
});

test("test_acquireAbsentWorktreeLease_reconcilesToOneOwnerAfterAChildIsKilledRightAfterWritingTheIntent", async () => {
    // Scenario: the process dies right after journaling the intent, before any physical mutation.
    const { root, worktreePath, leasePath } = makeAcquisitionFixture();
    await runAcquisitionInChildAndKillAfter(root, "intent");
    const result = acquireAbsentWorktreeLease(1, "run-a", root);
    assert.deepEqual(result, { acquired: true });
    assert.equal(JSON.parse(readFileSync(leasePath, "utf8")).runId, "run-a");
    const onDisk = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))[0].run;
    assert.equal(onDisk.leaseRunId, "run-a");
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), false);
});

test("test_acquireAbsentWorktreeLease_reconcilesToOneOwnerAfterAChildIsKilledRightAfterUpdatingTaskState", async () => {
    // Scenario: the process dies after both authorities already agree, but before the intent is deleted.
    const { root, worktreePath, leasePath } = makeAcquisitionFixture();
    await runAcquisitionInChildAndKillAfter(root, "state");
    const result = acquireAbsentWorktreeLease(1, "run-a", root);
    assert.deepEqual(result, { acquired: true });
    assert.equal(JSON.parse(readFileSync(leasePath, "utf8")).runId, "run-a");
    const onDisk = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"))[0].run;
    assert.equal(onDisk.leaseRunId, "run-a");
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), false);
});

// --- feedback-phase7-2 F7: reconciliation must never overwrite a different physical owner
// that legitimately appeared during the recovery window between the kill and the retry. ---

test("test_adoptWorktreeLease_refusesReconciliationWhenAThirdOwnerAppearsInTheRecoveryWindowAfterTheLeaseIsAlreadyWritten", async () => {
    // Scenario: the process dies right after replacing the physical lease. A supervisor clears
    // only the deliberately stale guards, exactly as the existing kill/retry tests do. Before the
    // retry, another owner legitimately takes the physical lease.
    const { root, worktreePath, leasePath } = makeAdoptionFixture();
    writeFileSync(leasePath, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    await runAdoptionInChildAndKillAfter(root, "lease");
    const otherOwnerBytes = JSON.stringify({ runId: "run-other", pid: 999, createdAt: 987654 });
    writeFileSync(leasePath, otherOwnerBytes);
    const tasksBefore = readFileSync(join(root, "tasks.json"), "utf8");
    // The retry must refuse rather than overwrite run-other's legitimate lease.
    assert.throws(() => adoptWorktreeLease(1, "run-new", root));
    assert.equal(readFileSync(leasePath, "utf8"), otherOwnerBytes);
    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksBefore);
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), true);
});

test("test_adoptWorktreeLease_refusesReconciliationWhenAThirdOwnerAppearsAfterAnIntentOnlySurvivor", async () => {
    // Scenario: the process dies right after journaling the intent, before either authority
    // changed. A different physical owner appears before the retry.
    const { root, worktreePath, leasePath } = makeAdoptionFixture();
    writeFileSync(leasePath, JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 }));
    await runAdoptionInChildAndKillAfter(root, "intent");
    const otherOwnerBytes = JSON.stringify({ runId: "run-other", pid: 999, createdAt: 987654 });
    writeFileSync(leasePath, otherOwnerBytes);
    const tasksBefore = readFileSync(join(root, "tasks.json"), "utf8");
    assert.throws(() => adoptWorktreeLease(1, "run-new", root));
    assert.equal(readFileSync(leasePath, "utf8"), otherOwnerBytes);
    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksBefore);
    assert.equal(existsSync(`${worktreePath}.lease.adopt-intent`), true);
});

test("test_adoptWorktreeLease_rollbackPathRefusesToOverwriteAThirdOwnerWithThePriorLeaseBytes", () => {
    // Scenario: a retained intent whose finish condition is false (its recorded new owner is
    // not the currently active run, so reconciliation must roll back) finds a third owner
    // holding the physical lease instead of either the recorded prior state or its own new
    // owner. Rolling back must not stomp that third owner with previousLeaseBytes.
    const { root, worktreePath, leasePath } = makeAdoptionFixture();
    const priorOwnerBytes = JSON.stringify({ runId: "run-old", pid: 1, createdAt: 1 });
    const intent = {
        taskNumber: 1, worktreePath,
        previousLeaseBytes: priorOwnerBytes, previousStateOwner: "run-old",
        newOwnerRunId: "run-stale",
    };
    writeFileSync(`${leasePath}.adopt-intent`, JSON.stringify(intent));
    const otherOwnerBytes = JSON.stringify({ runId: "run-other", pid: 999, createdAt: 987654 });
    writeFileSync(leasePath, otherOwnerBytes);
    const tasksBefore = readFileSync(join(root, "tasks.json"), "utf8");
    // run-new is the active run in this fixture, not "run-stale", so reconciliation would take
    // the rollback branch if it were allowed to proceed at all.
    assert.throws(() => adoptWorktreeLease(1, "run-new", root));
    assert.equal(readFileSync(leasePath, "utf8"), otherOwnerBytes);
    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksBefore);
    assert.equal(existsSync(`${leasePath}.adopt-intent`), true);
});

test("test_getAttemptCount_returnsZeroWhenNeverRaised", () => {
    // Setup: a task with an active run that has no attempts field at all.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Test action: read a counter that has never been raised.
    const count = getAttemptCount(1, "clarifyRounds", root);
    // Verification: it reads as zero.
    assert.equal(count, 0);
});

test("test_raiseAttemptCount_incrementsAndReturnsTheNewValue", () => {
    // Setup: a task with an active run.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Test action: raise the same counter twice.
    const first = raiseAttemptCount(1, "run-a", "testFixes", root);
    const second = raiseAttemptCount(1, "run-a", "testFixes", root);
    // Verification: each call returns the counter's new value.
    assert.equal(first, 1);
    assert.equal(second, 2);
});

test("test_raiseAttemptCount_persistsToTasksJson", () => {
    // Setup: a task with an active run.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Test action: raise a counter, then read it back through getAttemptCount.
    raiseAttemptCount(1, "run-a", "mergeAttempts", root);
    const count = getAttemptCount(1, "mergeAttempts", root);
    // Verification: the raise was written to disk, not just returned in memory.
    assert.equal(count, 1);
});

test("test_raiseAttemptCount_tracksEachCounterNameIndependently", () => {
    // Setup: a task with an active run.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Test action: raise one counter three times and a different counter once.
    raiseAttemptCount(1, "run-a", "conflictFixes", root);
    raiseAttemptCount(1, "run-a", "conflictFixes", root);
    raiseAttemptCount(1, "run-a", "conflictFixes", root);
    raiseAttemptCount(1, "run-a", "reviews", root);
    // Verification: the two counters hold separate values.
    assert.equal(getAttemptCount(1, "conflictFixes", root), 3);
    assert.equal(getAttemptCount(1, "reviews", root), 1);
});

test("test_raiseAttemptCount_throwsWhenExpectedRunIdIsNotTheNewestRun", () => {
    // Setup: a task with an active run under a different runId.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    // Test action: raising with a stale runId throws.
    assert.throws(() => raiseAttemptCount(1, "run-stale", "testFixes", root));
});

test("test_MAX_ATTEMPTS_isTwo", () => {
    // Verification: the pipeline's retry cap is two.
    assert.equal(MAX_ATTEMPTS, 2);
});
