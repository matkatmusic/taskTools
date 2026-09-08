// Behavioral checks for scripts/steps/pipeline-reviewPlan/VERDICT_ACCEPT.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/VERDICT_ACCEPT.ts";

const PACKET = {
    taskNumber: 42, taskStateRoot: "/repo", repoRoot: "/repo/wt", planFile: "/repo/wt/plans/plan.json",
    runId: "run-1", sourceBranch: "main",
};

test("test_main_forwardsThePlanPathTowardImplement", () => {
    const output = main(JSON.stringify(PACKET));
    assert.equal(output.box, "VERDICT_ACCEPT");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.taskNumber, 42);
    assert.equal(output.taskStateRoot, "/repo");
    assert.equal(output.repoRoot, "/repo/wt");
    assert.equal(output.planFile, "/repo/wt/plans/plan.json");
});

test("test_main_carriesRunIdAndSourceBranchForward", () => {
    const output = main(JSON.stringify(PACKET));
    assert.equal(output.runId, "run-1");
    assert.equal(output.sourceBranch, "main");
});
