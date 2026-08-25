// Behavioral checks for scripts/steps/pipeline-reviewPlan/EXIT_WORKFLOW_REVIEW_PLAN.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/EXIT_WORKFLOW_REVIEW_PLAN.ts";

test("test_main_handsOffTheExitTypeAndNoteToFailuresExit", () => {
    const output = main(JSON.stringify({ taskNumber: 42, taskStateRoot: "/repo", repoRoot: "/repo/wt", exitType: "plan-scrapped", exitNote: "codex did not accept the plan in two reviews" }));
    assert.equal(output.box, "EXIT_WORKFLOW_REVIEW_PLAN");
    assert.equal(output.exitType, "plan-scrapped");
    assert.equal(output.exitNote, "codex did not accept the plan in two reviews");
});
