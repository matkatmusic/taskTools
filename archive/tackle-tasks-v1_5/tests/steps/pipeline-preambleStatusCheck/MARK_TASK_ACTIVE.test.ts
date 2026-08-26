// MARK_TASK_ACTIVE.ts: mark the task active. Mutating: uses a temp tasks.json, never the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../../../scripts/steps/pipeline-preambleStatusCheck/MARK_TASK_ACTIVE.ts";
import { claimTask, readTaskRunState } from "../../../scripts/tackle-tasks/taskRunState.ts";
import { getTemplateShapeMismatches } from "../../../scripts/templateShape.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/steps/pipeline-preambleStatusCheck/MARK_TASK_ACTIVE.template.json");

function makeTasksFile(openTasks: unknown[]): { tasksFile: string; projectRoot: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), "MARK_TASK_ACTIVE-"));
    writeFileSync(join(projectRoot, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(projectRoot, "completedTasks.json"), JSON.stringify([]));
    return { tasksFile: join(projectRoot, "tasks.json"), projectRoot };
}

test("test_MARK_TASK_ACTIVE_marksTheTaskActiveInTasksJson", () => {
    const { tasksFile, projectRoot } = makeTasksFile([{ taskNumber: 1 }]);
    const output = main(JSON.stringify({ taskNumber: 1, tasksFile }));
    assert.deepEqual({ ...output, runId: "" }, { box: "MARK_TASK_ACTIVE", scriptSignal: "continue", taskNumber: 1, tasksFile, runId: "" });
    assert.equal(typeof output.runId, "string");
    assert.notEqual(output.runId, "");
    assert.equal(readTaskRunState(1, projectRoot).active, true);

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_MARK_TASK_ACTIVE_throwsWhenTheTaskIsAlreadyActive", () => {
    const { tasksFile, projectRoot } = makeTasksFile([{ taskNumber: 1 }]);
    claimTask(1, "run-a", projectRoot);
    assert.throws(() => main(JSON.stringify({ taskNumber: 1, tasksFile })), /could not be marked active/);
});
