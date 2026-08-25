// Behavioral checks for scripts/steps/pipeline-reviewPlan/ARE_2_REVIEWS_DONE.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewPlan/ARE_2_REVIEWS_DONE.ts";

function packet(reviewCount: number) {
    return {
        taskNumber: 42, taskStateRoot: "/repo", repoRoot: "/repo/wt", reviewCount,
        runId: "run-1", sourceBranch: "main", plan: { task: 42, revision: 1, createsFiles: [], sections: [] },
    };
}

test("test_main_replansWhenOnlyOneReviewHasHappened", () => {
    const output = main(JSON.stringify(packet(1)));
    assert.equal(output.next, "PLAN_PIPELINE");
    assert.equal(output.exitType, "");
    assert.equal(output.exitNote, "");
});

test("test_main_scrapsTheTaskAfterTwoReviews", () => {
    const output = main(JSON.stringify(packet(2)));
    assert.equal(output.next, "EXIT_WORKFLOW_REVIEW_PLAN");
    assert.equal(output.exitType, "plan-scrapped");
    assert.equal(output.exitNote, "codex did not accept the plan in two reviews");
});

test("test_main_carriesRunIdSourceBranchAndPlanForward", () => {
    const p = packet(1);
    const output = main(JSON.stringify(p));
    assert.equal(output.runId, "run-1");
    assert.equal(output.sourceBranch, "main");
    assert.deepEqual(output.plan, p.plan);
});
