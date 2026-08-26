// Behavioral checks for scripts/steps/pipeline-implement/TASK_TESTS_PIPELINE.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-implement/TASK_TESTS_PIPELINE.ts";

test("test_main_forwardsThePayloadAndDropsTheEnvelopeItReceived", () => {
    const input = {
        box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: "continue",
        projectRoot: "/abs/project", worktreePath: "/abs/project/.worktrees/task-42",
        taskNumber: 42, runId: "run-1", sourceBranch: "main",
        commits: [{ occurrenceId: "", hash: "abc123", kind: "work", stepId: "implement" }],
    };
    const output = main(JSON.stringify(input));
    assert.equal(output.box, "TASK_TESTS_PIPELINE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.taskNumber, 42);
    assert.deepEqual(output.commits, input.commits);
});
