// Behavioral checks for scripts/steps/pipeline-reviewPlan/VERDICT_AMEND.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/VERDICT_AMEND.ts";

const PACKET = {
    taskNumber: 42, taskStateRoot: "/repo", repoRoot: "/repo/wt", notes: "fix the thing",
    runId: "run-1", sourceBranch: "main",
};

test("test_main_forwardsTheNotesTowardUpdateTaskEntry", () => {
    const output = main(JSON.stringify(PACKET));
    assert.equal(output.box, "VERDICT_AMEND");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.notes, "fix the thing");
});

test("test_main_carriesRunIdAndSourceBranchForward", () => {
    const output = main(JSON.stringify(PACKET));
    assert.equal(output.runId, "run-1");
    assert.equal(output.sourceBranch, "main");
});
