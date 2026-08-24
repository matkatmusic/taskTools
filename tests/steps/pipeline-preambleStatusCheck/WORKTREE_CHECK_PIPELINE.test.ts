// WORKTREE_CHECK_PIPELINE.ts is the hand-off into pipeline-worktreeCheck.mmd.
// Run alone: node --test tests/steps/pipeline-preambleStatusCheck/WORKTREE_CHECK_PIPELINE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-preambleStatusCheck/WORKTREE_CHECK_PIPELINE.ts";

test("test_WORKTREE_CHECK_PIPELINE_forwardsTaskNumberTasksFileAndRunId", () => {
    const output = main(JSON.stringify({ box: "MARK_TASK_ACTIVE", scriptSignal: "continue", taskNumber: 1, tasksFile: "/tmp/tasks.json", runId: "run-1" }));
    assert.deepEqual(output, {
        box: "WORKTREE_CHECK_PIPELINE", scriptSignal: "continue", taskNumber: 1, tasksFile: "/tmp/tasks.json", runId: "run-1",
    });
});
