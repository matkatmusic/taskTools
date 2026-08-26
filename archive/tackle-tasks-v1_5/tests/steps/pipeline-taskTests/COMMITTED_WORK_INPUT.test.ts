// Behavioral checks for scripts/steps/pipeline-taskTests/COMMITTED_WORK_INPUT.ts.
// Run: node --test tests/steps/pipeline-taskTests/COMMITTED_WORK_INPUT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-taskTests/COMMITTED_WORK_INPUT.ts";

const PACKET = { taskNumber: 1, runId: "run-1", worktreePath: "/abs/worktree", sourceBranch: "main", projectRoot: "/abs/project" };

test("test_COMMITTED_WORK_INPUT_forwardsThePacketUnchanged", () => {
    const output = main(JSON.stringify(PACKET));
    assert.deepEqual(output, { box: "COMMITTED_WORK_INPUT", scriptSignal: "continue", ...PACKET });
});
