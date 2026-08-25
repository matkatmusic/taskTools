import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-plan/PLANNER_RETURNED_PLAN.ts";

const base = { taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", sourceBranch: "master", projectRoot: "/tmp/fake-project" };
const planFile = "scripts/steps/pipeline-plan/fixtures/worktree/plans/plan.json";

test("test_PLANNER_RETURNED_PLAN_forwardsRunIdentityAndThePlanForReview", () => {
    const output = main(JSON.stringify({ ...base, planFile, clarifyRequest: null, next: "PLANNER_RETURNED_PLAN" }));
    assert.deepEqual(output, { box: "PLANNER_RETURNED_PLAN", scriptSignal: "continue", ...base, planFile, clarifyRequest: null });
});
