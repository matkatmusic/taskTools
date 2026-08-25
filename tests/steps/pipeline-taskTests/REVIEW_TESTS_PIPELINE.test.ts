// Behavioral checks for scripts/steps/pipeline-taskTests/REVIEW_TESTS_PIPELINE.ts.
// Run: node --test tests/steps/pipeline-taskTests/REVIEW_TESTS_PIPELINE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-taskTests/REVIEW_TESTS_PIPELINE.ts";

const PACKET = { taskNumber: 1, runId: "run-1", worktreePath: "/abs/worktree", sourceBranch: "main", projectRoot: "/abs/project" };

test("test_REVIEW_TESTS_PIPELINE_handsOffThePacket", () => {
    const output = main(JSON.stringify({ box: "DO_TASK_TESTS_PASS", scriptSignal: "continue", ...PACKET, next: "REVIEW_TESTS_PIPELINE" }));
    assert.deepEqual(output, { box: "REVIEW_TESTS_PIPELINE", scriptSignal: "continue", ...PACKET });
});
