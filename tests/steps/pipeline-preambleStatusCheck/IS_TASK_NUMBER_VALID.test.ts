// IS_TASK_NUMBER_VALID.ts is "is task number valid?" in pipeline-preambleStatusCheck.mmd.
// Run alone: node --test tests/steps/pipeline-preambleStatusCheck/IS_TASK_NUMBER_VALID.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-preambleStatusCheck/IS_TASK_NUMBER_VALID.ts";

function makeTasksFile(openTasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "IS_TASK_NUMBER_VALID-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
    return join(root, "tasks.json");
}

test("test_IS_TASK_NUMBER_VALID_continuesToIsTaskBlockedWhenTheTaskIsInTasksJson", () => {
    const tasksFile = makeTasksFile([{ taskNumber: 1 }]);
    const output = main(JSON.stringify({ taskNumber: 1, tasksFile }));
    assert.deepEqual(output, {
        box: "IS_TASK_NUMBER_VALID", scriptSignal: "continue", next: "IS_TASK_BLOCKED",
        taskNumber: 1, tasksFile, exitType: "", exitNote: "",
    });
});

test("test_IS_TASK_NUMBER_VALID_exitsWhenTheTaskNumberIsNotInTasksJson", () => {
    const tasksFile = makeTasksFile([{ taskNumber: 1 }]);
    const output = main(JSON.stringify({ taskNumber: 999, tasksFile }));
    assert.deepEqual(output, {
        box: "IS_TASK_NUMBER_VALID", scriptSignal: "continue", next: "REPORT_ONLY_EXIT",
        taskNumber: 999, tasksFile, exitType: "invalid-number", exitNote: "task number is not in tasks.json",
    });
});
