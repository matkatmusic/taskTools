// PREAMBLE_STATUS_CHECK.ts is "is the task number valid?" in pipeline-preambleStatusCheck.mmd.  Run alone: node --test scripts/tackle-tasks/preambleStatusCheck/PREAMBLE_STATUS_CHECK.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./PREAMBLE_STATUS_CHECK.ts";
import { taskBranchName } from "../shared/createTaskWorktree.ts";

function makeTasksFile(openTasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "PREAMBLE_STATUS_CHECK-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
    return join(root, "tasks.json");
}

test("test_PREAMBLE_STATUS_CHECK_continuesToIsTaskBlockedWhenTheTaskIsInTasksJson", () => {
    const tasksFile = makeTasksFile([{ taskNumber: 1 }]);
    const output = main(JSON.stringify({ taskNumber: 1, tasksFile }));
    assert.deepEqual(output, {
        box: "PREAMBLE_STATUS_CHECK", scriptSignal: "continue", taskNumber: 1, runId: "",
        projectRoot: output.projectRoot, worktree: "", branch: taskBranchName(1), docsMode: "", planFile: "",
        exitType: "", exitNote: "", next: "IS_TASK_BLOCKED_Q",
    });
});

test("test_PREAMBLE_STATUS_CHECK_exitsWhenTheTaskNumberIsNotInTasksJson", () => {
    const tasksFile = makeTasksFile([{ taskNumber: 1 }]);
    const output = main(JSON.stringify({ taskNumber: 999, tasksFile }));
    assert.deepEqual(output, {
        box: "PREAMBLE_STATUS_CHECK", scriptSignal: "continue", taskNumber: 999, runId: "",
        projectRoot: output.projectRoot, worktree: "", branch: taskBranchName(999), docsMode: "", planFile: "",
        exitType: "invalid-number", exitNote: "task number is not in tasks.json", next: "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT",
    });
});
