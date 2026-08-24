// MARK_TASK_ACTIVE.ts is "Try: mark the task active in tasks.json" in pipeline-preambleStatusCheck.mmd.
// Mutating: always exercised against a temp tasks.json, never the real one.
// Run alone: node --test tests/steps/pipeline-preambleStatusCheck/MARK_TASK_ACTIVE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-preambleStatusCheck/MARK_TASK_ACTIVE.ts";
import { claimTask, readTaskRunState } from "../../../scripts/tackle-tasks/taskRunState.ts";

function makeTasksFile(openTasks: unknown[]): { tasksFile: string; projectRoot: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), "MARK_TASK_ACTIVE-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(projectRoot, "completedTasks.json"), JSON.stringify([]));
    return { tasksFile: join(projectRoot, "tasks.json"), projectRoot };
}

test("test_MARK_TASK_ACTIVE_marksTheTaskActiveInTasksJson", () => {
    const { tasksFile, projectRoot } = makeTasksFile([{ taskNumber: 1 }]);
    const output = main(JSON.stringify({ taskNumber: 1, tasksFile }));
    assert.deepEqual(output, { box: "MARK_TASK_ACTIVE", scriptSignal: "continue", taskNumber: 1, tasksFile });
    assert.equal(readTaskRunState(1, projectRoot).active, true);
});

test("test_MARK_TASK_ACTIVE_throwsWhenTheTaskIsAlreadyActive", () => {
    const { tasksFile, projectRoot } = makeTasksFile([{ taskNumber: 1 }]);
    claimTask(1, "run-a", projectRoot);
    assert.throws(() => main(JSON.stringify({ taskNumber: 1, tasksFile })), /could not be marked active/);
});
