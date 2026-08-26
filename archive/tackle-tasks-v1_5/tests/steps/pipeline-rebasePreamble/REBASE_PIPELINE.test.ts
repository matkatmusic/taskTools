// Run: node --test tests/steps/pipeline-rebasePreamble/REBASE_PIPELINE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-rebasePreamble/REBASE_PIPELINE.ts";

test("test_rebasePipeline_crossesIntoPipelineRebaseAndForwardsTheLockedRepo", () => {
    const result = main(JSON.stringify({ runId: "run-a", taskNumber: 1, projectRoot: "/abs/project" }));

    assert.equal(result.box, "REBASE_PIPELINE");
    assert.equal(result.scriptSignal, "continue");
    assert.equal(result.runId, "run-a");
    assert.equal(result.taskNumber, 1);
    assert.equal(result.projectRoot, "/abs/project");
    assert.equal(result.suiteFixAttempts, 0);
});
