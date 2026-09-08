// IS_TASK_ACTIVE.ts is "is the task active?" in pipeline-preambleStatusCheck.mmd.
// Run alone: node --test tests/steps/pipeline-preambleStatusCheck/IS_TASK_ACTIVE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-preambleStatusCheck/IS_TASK_ACTIVE.ts";
import { claimTask } from "../../../scripts/tackle-tasks/taskRunState.ts";

function makeTasksFile(openTasks: unknown[]): { tasksFile: string; projectRoot: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), "IS_TASK_ACTIVE-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(projectRoot, "completedTasks.json"), JSON.stringify([]));
    return { tasksFile: join(projectRoot, "tasks.json"), projectRoot };
}

test("test_IS_TASK_ACTIVE_continuesToMarkTaskActiveWhenNotActive", () => {
    const { tasksFile } = makeTasksFile([{ taskNumber: 1 }]);
    const output = main(JSON.stringify({ taskNumber: 1, tasksFile }));
    assert.deepEqual(output, {
        box: "IS_TASK_ACTIVE", scriptSignal: "continue", next: "MARK_TASK_ACTIVE",
        taskNumber: 1, tasksFile, exitType: "", exitNote: "",
    });
});

test("test_IS_TASK_ACTIVE_exitsWhenAPreviousRunLeftTheTaskActive", () => {
    const { tasksFile, projectRoot } = makeTasksFile([{ taskNumber: 1 }]);
    claimTask(1, "run-a", projectRoot);
    const output = main(JSON.stringify({ taskNumber: 1, tasksFile }));
    assert.deepEqual(output, {
        box: "IS_TASK_ACTIVE", scriptSignal: "continue", next: "REPORT_ONLY_EXIT",
        taskNumber: 1, tasksFile, exitType: "already-active", exitNote: "a previous run left the task active",
    });
});
