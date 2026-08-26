// PREAMBLE_TASK_NUMBER_INPUT.ts is "Input: { taskNumber, tasksFile }" in pipeline-preambleStatusCheck.mmd.
// Run alone: node --test tests/steps/pipeline-preambleStatusCheck/PREAMBLE_TASK_NUMBER_INPUT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-preambleStatusCheck/PREAMBLE_TASK_NUMBER_INPUT.ts";

test("test_PREAMBLE_TASK_NUMBER_INPUT_parsesTaskNumberAndTasksFileFromTheInputJson", () => {
    const output = main(JSON.stringify({ taskNumber: 1, tasksFile: "/tmp/tasks.json" }));
    assert.deepEqual(output, {
        box: "PREAMBLE_TASK_NUMBER_INPUT", scriptSignal: "continue", taskNumber: 1, tasksFile: "/tmp/tasks.json",
    });
});

test("test_PREAMBLE_TASK_NUMBER_INPUT_throwsWhenTaskNumberIsNotAnInteger", () => {
    assert.throws(() => main(JSON.stringify({ taskNumber: "banana", tasksFile: "/tmp/tasks.json" })), /taskNumber must be an integer/);
    assert.throws(() => main(JSON.stringify({ taskNumber: 1.5, tasksFile: "/tmp/tasks.json" })), /taskNumber must be an integer/);
    assert.throws(() => main(JSON.stringify({ tasksFile: "/tmp/tasks.json" })), /taskNumber must be an integer/);
});

test("test_PREAMBLE_TASK_NUMBER_INPUT_throwsWhenTasksFileIsMissingOrEmpty", () => {
    assert.throws(() => main(JSON.stringify({ taskNumber: 1 })), /tasksFile must be a non-empty string/);
    assert.throws(() => main(JSON.stringify({ taskNumber: 1, tasksFile: "" })), /tasksFile must be a non-empty string/);
    assert.throws(() => main(JSON.stringify({ taskNumber: 1, tasksFile: 7 })), /tasksFile must be a non-empty string/);
});
