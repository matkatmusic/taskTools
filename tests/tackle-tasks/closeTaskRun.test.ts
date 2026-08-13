// Behavioral checks for scripts/tackle-tasks/closeTaskRun.ts.
// Run: node --test tests/tackle-tasks/closeTaskRun.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTaskRun } from "../../scripts/tackle-tasks/closeTaskRun.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import type { TaskRunRecord, TaskRunState } from "../../scripts/tackle-tasks/taskRunState.ts";

function makeProjectRoot(tasks: unknown[], completed: unknown[] = []): string {
    const root = mkdtempSync(join(tmpdir(), "closeTaskRun-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    writeFileSync(join(root, "completedTasks.json"), `${JSON.stringify(completed, null, 2)}\n`);
    return root;
}

function readTasksJson(root: string): any[] {
    const { tasksPath } = resolveTaskFiles(root);
    return JSON.parse(readFileSync(tasksPath, "utf8"));
}

function readCompletedJson(root: string): any[] {
    const { completedTasksPath } = resolveTaskFiles(root);
    return JSON.parse(readFileSync(completedTasksPath, "utf8"));
}

function endedRunRecord(overrides: Partial<TaskRunRecord> = {}): TaskRunRecord {
    return {
        runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: "2026-08-01T00:10:00-07:00",
        exitType: "completed", exitNote: "done", modifiedFiles: [],
        commits: [{ occurrenceId: "", hash: "abc123", kind: "work" }],
        implementationNotesFile: null, taskTests: null, fullSuite: null,
        ...overrides,
    };
}

function completedRunState(record: TaskRunRecord = endedRunRecord()): TaskRunState {
    return { active: false, worktree: null, leaseRunId: null, history: [record] };
}

test("test_closeTaskRun_archivesAndUnblocksInOneCall", () => {
    // Setup: task 1's run has ended completed under run-a; task 2 is blocked on task 1.
    const root = makeProjectRoot([
        { taskNumber: 1, title: "finished", run: completedRunState() },
        { taskNumber: 2, title: "waiting", blockedBy: [{ taskNum: 1, reason: "needs 1 first" }] },
    ]);

    // Test action: close task 1.
    const output = closeTaskRun({
        taskNumber: 1, runId: "run-a", closureNote: "Task 1 completed.", projectRoot: root,
    });

    // Verification: closed/skipped/unblocked all come back from the one call, task 1 is
    // archived with hashes derived from its own run, and task 2 no longer lists it as a blocker.
    assert.deepEqual(output, { closed: [1], skipped: [], unblocked: [2] });
    const remaining = readTasksJson(root);
    const completed = readCompletedJson(root);
    assert.deepEqual(remaining.map((t: any) => t.taskNumber), [2]);
    assert.equal(remaining[0].blockedBy, undefined);
    assert.equal(completed[0].taskNumber, 1);
    assert.equal(completed[0].closureNote, "Task 1 completed.");
    assert.deepEqual(completed[0].commitHashes, ["abc123"]);
});

test("test_closeTaskRun_rejectsCallerSuppliedCommitHashes", () => {
    const root = makeProjectRoot([{ taskNumber: 1, title: "t", run: completedRunState() }]);

    assert.throws(() => closeTaskRun({
        taskNumber: 1, runId: "run-a", closureNote: "note", projectRoot: root,
        // @ts-expect-error rejected at runtime, not just by the type
        commitHashes: ["forged"],
    }));

    // Nothing was written: rejection happens before any file touch.
    assert.deepEqual(readTasksJson(root)[0].taskNumber, 1);
});

test("test_closeTaskRun_rejectsAnActiveRun", () => {
    const root = makeProjectRoot([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: null, leaseRunId: null, history: [endedRunRecord({ endedAt: null, exitType: null })] },
    }]);
    const tasksBefore = readFileSync(join(root, "tasks.json"), "utf8");
    const completedBefore = readFileSync(join(root, "completedTasks.json"), "utf8");

    assert.throws(() => closeTaskRun({ taskNumber: 1, runId: "run-a", closureNote: "note", projectRoot: root }));

    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksBefore);
    assert.equal(readFileSync(join(root, "completedTasks.json"), "utf8"), completedBefore);
});

test("test_closeTaskRun_rejectsANonCompletedExitType", () => {
    const root = makeProjectRoot([{
        taskNumber: 1, title: "t",
        run: completedRunState(endedRunRecord({ exitType: "run-failed" })),
    }]);
    const tasksBefore = readFileSync(join(root, "tasks.json"), "utf8");
    const completedBefore = readFileSync(join(root, "completedTasks.json"), "utf8");

    assert.throws(() => closeTaskRun({ taskNumber: 1, runId: "run-a", closureNote: "note", projectRoot: root }));

    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksBefore);
    assert.equal(readFileSync(join(root, "completedTasks.json"), "utf8"), completedBefore);
});

test("test_closeTaskRun_rejectsAStaleRunId", () => {
    const root = makeProjectRoot([{ taskNumber: 1, title: "t", run: completedRunState() }]);
    const tasksBefore = readFileSync(join(root, "tasks.json"), "utf8");
    const completedBefore = readFileSync(join(root, "completedTasks.json"), "utf8");

    assert.throws(() => closeTaskRun({ taskNumber: 1, runId: "run-stale", closureNote: "note", projectRoot: root }));

    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksBefore);
    assert.equal(readFileSync(join(root, "completedTasks.json"), "utf8"), completedBefore);
});

test("test_closeTaskRun_archiveFirstRetryReusesTheStoredNoteAndHashesInsteadOfOverwriting", () => {
    // Setup: simulates a failure after the completed-file write but before the tasks.json
    // removal — task 1 is present in BOTH files with the same run's real note/hashes archived.
    const runState = completedRunState();
    const archivedRecord = {
        taskNumber: 1, title: "finished", run: runState,
        completionDate: "2026-08-01", closureNote: "original archived note", commitHashes: ["abc123"],
    };
    const root = makeProjectRoot(
        [{ taskNumber: 1, title: "finished", run: runState }],
        [archivedRecord],
    );

    // Test action: retry the close with a deliberately different note (and no way to even
    // supply different hashes now — the contract no longer accepts them).
    const output = closeTaskRun({
        taskNumber: 1, runId: "run-a", closureNote: "a completely different, wrong note", projectRoot: root,
    });

    // Verification: the open record is removed, but the archive keeps its ORIGINAL bytes.
    assert.deepEqual(output, { closed: [1], skipped: [], unblocked: [] });
    assert.deepEqual(readTasksJson(root).map((t: any) => t.taskNumber), []);
    const completed = readCompletedJson(root);
    assert.equal(completed[0].closureNote, "original archived note");
    assert.deepEqual(completed[0].commitHashes, ["abc123"]);
});

test("test_closeTaskRun_reconcilesSuccessAfterACompleteSuccessWithoutRewrite", () => {
    // Setup: task 1 already fully closed — present only in completedTasks.json — with a
    // record that matches exactly what this call would have produced.
    const runState = completedRunState();
    const archivedRecord = {
        taskNumber: 1, title: "finished", run: runState,
        completionDate: "2026-08-01", closureNote: "the real note", commitHashes: ["abc123"],
    };
    const root = makeProjectRoot([], [archivedRecord]);
    const completedBefore = readFileSync(join(root, "completedTasks.json"), "utf8");

    const output = closeTaskRun({ taskNumber: 1, runId: "run-a", closureNote: "the real note", projectRoot: root });

    assert.deepEqual(output, { closed: [1], skipped: [], unblocked: [] });
    // Reconciliation never writes.
    assert.equal(readFileSync(join(root, "completedTasks.json"), "utf8"), completedBefore);
});

test("test_closeTaskRun_reportsAmbiguityWhenTheOnlyArchivedRecordDoesNotMatchThisCall", () => {
    // Setup: task 1 is archived, but this call's note disagrees with what is stored — never
    // report success, never overwrite.
    const runState = completedRunState();
    const archivedRecord = {
        taskNumber: 1, title: "finished", run: runState,
        completionDate: "2026-08-01", closureNote: "the real note", commitHashes: ["abc123"],
    };
    const root = makeProjectRoot([], [archivedRecord]);
    const completedBefore = readFileSync(join(root, "completedTasks.json"), "utf8");

    const output = closeTaskRun({ taskNumber: 1, runId: "run-a", closureNote: "a different note", projectRoot: root });

    assert.deepEqual(output, { closed: [], skipped: [1], unblocked: [] });
    assert.equal(readFileSync(join(root, "completedTasks.json"), "utf8"), completedBefore);
});

test("test_closeTaskRun_reportsNotFoundWhenTheTaskIsInNeitherFile", () => {
    const root = makeProjectRoot([], []);

    const output = closeTaskRun({ taskNumber: 99, runId: "run-a", closureNote: "note", projectRoot: root });

    assert.deepEqual(output, { closed: [], skipped: [99], unblocked: [] });
});
