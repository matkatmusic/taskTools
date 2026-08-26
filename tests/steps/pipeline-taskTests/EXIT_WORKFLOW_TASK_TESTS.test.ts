// Behavioral checks for scripts/steps/pipeline-taskTests/EXIT_WORKFLOW_TASK_TESTS.ts.  Run: node --test tests/steps/pipeline-taskTests/EXIT_WORKFLOW_TASK_TESTS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-taskTests/EXIT_WORKFLOW_TASK_TESTS.ts";

const PACKET = { taskNumber: 1, runId: "run-1", worktreePath: "/abs/worktree", sourceBranch: "main", projectRoot: "/abs/project" };

test("test_EXIT_WORKFLOW_TASK_TESTS_forwardsTheExitTypeAndNote", () => {
    const input = {
        box: "ARE_2_TEST_FIXES_DONE", scriptSignal: "continue", ...PACKET,
        exitType: "tests-red", exitNote: "task tests still failing after 2 fix attempts", next: "EXIT_WORKFLOW_TASK_TESTS",
    };
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, {
        box: "EXIT_WORKFLOW_TASK_TESTS", scriptSignal: "continue",
        taskNumber: 1, runId: "run-1", projectRoot: "/abs/project", worktree: "/abs/worktree", sourceBranch: "main",
        exitType: "tests-red", exitNote: "task tests still failing after 2 fix attempts",
    });
});
