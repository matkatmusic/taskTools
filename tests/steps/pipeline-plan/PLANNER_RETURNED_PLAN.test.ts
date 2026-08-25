import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-plan/PLANNER_RETURNED_PLAN.ts";

const base = { taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", sourceBranch: "master", projectRoot: "/tmp/fake-project" };
const samplePlan = { task: 35, revision: 1, createsFiles: [], sections: [{ id: "sentinel-step", title: "sentinel", body: "sentinel body", codexNotes: "" }] };

test("test_PLANNER_RETURNED_PLAN_forwardsRunIdentityAndThePlanForReview", () => {
    const output = main(JSON.stringify({ ...base, plan: samplePlan, clarifyRequest: null, next: "PLANNER_RETURNED_PLAN" }));
    assert.deepEqual(output, { box: "PLANNER_RETURNED_PLAN", scriptSignal: "continue", ...base, plan: samplePlan, clarifyRequest: null });
});
