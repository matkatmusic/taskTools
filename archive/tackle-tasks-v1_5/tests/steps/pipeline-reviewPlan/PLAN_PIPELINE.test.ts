// Behavioral checks for scripts/steps/pipeline-reviewPlan/PLAN_PIPELINE.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/PLAN_PIPELINE.ts";

test("test_main_translatesToTheReplanPipelinesDocsInputShape", () => {
    const output = main(JSON.stringify({
        taskNumber: 42, taskStateRoot: "/repo", repoRoot: "/repo/wt", exitType: "", exitNote: "",
        runId: "run-1", sourceBranch: "main",
    }));
    assert.equal(output.box, "PLAN_PIPELINE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.taskNumber, 42);
    assert.equal(output.runId, "run-1");
    assert.equal(output.worktree, "/repo/wt");
    assert.equal(output.branch, "main");
    assert.equal(output.projectRoot, "/repo");
});
