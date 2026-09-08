// Behavioral checks for scripts/steps/pipeline-taskTests/DO_TASK_TESTS_PASS.ts.
// Run: node --test tests/steps/pipeline-taskTests/DO_TASK_TESTS_PASS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-taskTests/DO_TASK_TESTS_PASS.ts";

const PACKET = { taskNumber: 1, runId: "run-1", worktreePath: "/abs/worktree", sourceBranch: "main", projectRoot: "/abs/project" };

test("test_DO_TASK_TESTS_PASS_choosesReviewTestsWhenPassed", () => {
    const output = main(JSON.stringify({ box: "RUN_TASK_TESTS", scriptSignal: "continue", mutating: true, ...PACKET, passed: true }));
    assert.deepEqual(output, { box: "DO_TASK_TESTS_PASS", scriptSignal: "continue", ...PACKET, next: "REVIEW_TESTS_PIPELINE" });
});

test("test_DO_TASK_TESTS_PASS_choosesAre2TestFixesDoneWhenRed", () => {
    const output = main(JSON.stringify({ box: "RUN_TASK_TESTS", scriptSignal: "continue", mutating: true, ...PACKET, passed: false }));
    assert.deepEqual(output, { box: "DO_TASK_TESTS_PASS", scriptSignal: "continue", ...PACKET, next: "ARE_2_TEST_FIXES_DONE" });
});
