// Behavioral checks for ARCHIVE_TASK.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./ARCHIVE_TASK.ts";
import { resolveTaskFiles } from "../../shared/taskFiles.ts";
import type { TaskRunRecord, TaskRunState } from "../shared/taskRunState.ts";
import { getTemplateShapeMismatches } from "../../shared/templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "ARCHIVE_TASK.template.json");

function makeProjectRoot(tasks: unknown[], completed: unknown[] = []): string {
    const root = mkdtempSync(join(tmpdir(), "archive-task-"));
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

function samplePacket(projectRoot: string, taskNumber: number, runId: string, closureNote: string): Record<string, unknown> {
    return { box: "MARK_TASK_INACTIVE_SUCCESS", scriptSignal: "continue", projectRoot, taskNumber, runId, closureNote };
}

test("test_ARCHIVE_TASK_archivesAndUnblocksInOneCall", () => {
    const root = makeProjectRoot([
        { taskNumber: 1, title: "finished", run: completedRunState() },
        { taskNumber: 2, title: "waiting", blockedBy: [{ taskNumber: 1, reason: "needs 1 first" }] },
    ]);

    const output = main(JSON.stringify(samplePacket(root, 1, "run-a", "Task 1 completed.")));

    assert.equal(output.box, "ARCHIVE_TASK");
    assert.equal(output.taskNumber, 1);
    assert.equal(output.closureNote, "Task 1 completed.");
    const remaining = readTasksJson(root);
    const completed = readCompletedJson(root);
    assert.deepEqual(remaining.map((t: any) => t.taskNumber), [2]);
    assert.equal(remaining[0].blockedBy, undefined);
    assert.equal(completed[0].taskNumber, 1);
    assert.equal(completed[0].closureNote, "Task 1 completed.");
    assert.deepEqual(completed[0].commitHashes, ["abc123"]);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_ARCHIVE_TASK_throwsWhenTheRunIsNotEndedAndCompleted", () => {
    const root = makeProjectRoot([{
        taskNumber: 1, title: "t",
        run: completedRunState(endedRunRecord({ exitType: "run-failed" })),
    }]);
    const tasksBefore = readFileSync(join(root, "tasks.json"), "utf8");
    const completedBefore = readFileSync(join(root, "completedTasks.json"), "utf8");

    assert.throws(() => main(JSON.stringify(samplePacket(root, 1, "run-a", "note"))));

    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksBefore);
    assert.equal(readFileSync(join(root, "completedTasks.json"), "utf8"), completedBefore);
});

test("test_ARCHIVE_TASK_runsTwiceWithTheSameInput", () => {
    const root = makeProjectRoot([
        { taskNumber: 1, title: "finished", run: completedRunState() },
    ]);
    const input = JSON.stringify(samplePacket(root, 1, "run-a", "Task 1 completed."));

    const first = main(input);
    const tasksAfterFirst = readTasksJson(root);
    const completedAfterFirst = readCompletedJson(root);
    const second = main(input);
    const tasksAfterSecond = readTasksJson(root);
    const completedAfterSecond = readCompletedJson(root);

    assert.deepEqual(second, first);
    assert.deepEqual(tasksAfterSecond, tasksAfterFirst);
    assert.deepEqual(completedAfterSecond, completedAfterFirst);
});

// The box throws rather than reporting skipped/ambiguous silently: a failed archive must never reach REPORT_CLOSURE_NOTE.
test("test_ARCHIVE_TASK_throwsWhenTheTaskIsInNeitherFile", () => {
    const root = makeProjectRoot([], []);

    assert.throws(
        () => main(JSON.stringify(samplePacket(root, 99, "run-a", "note"))),
        (error: Error) => error.message.includes("99"),
    );
});
