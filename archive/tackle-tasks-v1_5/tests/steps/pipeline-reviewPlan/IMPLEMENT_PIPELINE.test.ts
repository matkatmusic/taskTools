// Behavioral checks for scripts/steps/pipeline-reviewPlan/IMPLEMENT_PIPELINE.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/IMPLEMENT_PIPELINE.ts";

test("test_main_translatesToTheImplementPipelinesAcceptedPlanInputShape", () => {
    const output = main(JSON.stringify({
        taskNumber: 42, taskStateRoot: "/repo", repoRoot: "/repo/wt", planFile: "/repo/wt/plans/plan.json",
        runId: "run-1", sourceBranch: "main",
    }));
    assert.equal(output.box, "IMPLEMENT_PIPELINE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.taskNumber, 42);
    assert.equal(output.projectRoot, "/repo");
    assert.equal(output.worktreePath, "/repo/wt");
    assert.equal(output.runId, "run-1");
    assert.equal(output.sourceBranch, "main");
    assert.equal(output.maxFixRounds, 3);
});

test("test_main_leavesTypecheckCommandUnsetRatherThanGuessOne", () => {
    const output = main(JSON.stringify({
        taskNumber: 42, taskStateRoot: "/repo", repoRoot: "/repo/wt", planFile: "/repo/wt/plans/plan.json",
        runId: "run-1", sourceBranch: "main",
    }));
    assert.equal("typecheckCommand" in output, false);
});
