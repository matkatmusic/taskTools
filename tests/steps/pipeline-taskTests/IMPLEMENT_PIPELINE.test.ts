// Behavioral checks for scripts/steps/pipeline-taskTests/IMPLEMENT_PIPELINE.ts.  Run: node --test tests/steps/pipeline-taskTests/IMPLEMENT_PIPELINE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-taskTests/IMPLEMENT_PIPELINE.ts";

const PACKET = { taskNumber: 1, runId: "run-1", worktreePath: "/abs/worktree", sourceBranch: "main", projectRoot: "/abs/project" };

test("test_IMPLEMENT_PIPELINE_addsTheDefaultMaxFixRounds", () => {
    const input = { box: "AMEND_ENTRY_WITH_FAILING_TESTS", scriptSignal: "continue", mutating: true, ...PACKET, amendFailingTests: true };
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, { box: "IMPLEMENT_PIPELINE", scriptSignal: "continue", ...PACKET, maxFixRounds: 3 });
});
