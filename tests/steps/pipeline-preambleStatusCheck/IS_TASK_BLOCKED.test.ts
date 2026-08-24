// IS_TASK_BLOCKED.ts is "is task blocked?" in pipeline-preambleStatusCheck.mmd.
// Run alone: node --test tests/steps/pipeline-preambleStatusCheck/IS_TASK_BLOCKED.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-preambleStatusCheck/IS_TASK_BLOCKED.ts";

function makeTasksFile(openTasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "IS_TASK_BLOCKED-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
    return join(root, "tasks.json");
}

test("test_IS_TASK_BLOCKED_exitsWhenBlockedByNamesAnOpenTask", () => {
    const tasksFile = makeTasksFile([
        { taskNumber: 1, blockedBy: [{ taskNum: 2, reason: "needs schema" }] },
        { taskNumber: 2 },
    ]);
    const output = main(JSON.stringify({ taskNumber: 1, tasksFile }));
    assert.deepEqual(output, {
        box: "IS_TASK_BLOCKED", scriptSignal: "continue", next: "REPORT_ONLY_EXIT",
        taskNumber: 1, tasksFile, exitType: "blocked", note: "an open blocker remains",
    });
});

test("test_IS_TASK_BLOCKED_continuesToIsTaskActiveWhenTheBlockerIsNotOpen", () => {
    const tasksFile = makeTasksFile([{ taskNumber: 1, blockedBy: [{ taskNum: 2, reason: "needs schema" }] }]);
    const output = main(JSON.stringify({ taskNumber: 1, tasksFile }));
    assert.deepEqual(output, {
        box: "IS_TASK_BLOCKED", scriptSignal: "continue", next: "IS_TASK_ACTIVE",
        taskNumber: 1, tasksFile, exitType: "", note: "",
    });
});

test("test_IS_TASK_BLOCKED_continuesToIsTaskActiveWhenThereIsNoBlockedByField", () => {
    const tasksFile = makeTasksFile([{ taskNumber: 1 }]);
    const output = main(JSON.stringify({ taskNumber: 1, tasksFile }));
    assert.deepEqual(output, {
        box: "IS_TASK_BLOCKED", scriptSignal: "continue", next: "IS_TASK_ACTIVE",
        taskNumber: 1, tasksFile, exitType: "", note: "",
    });
});
