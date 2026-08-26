import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-plan/REVIEW_PLAN_PIPELINE.ts";

const base = { taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", sourceBranch: "master", projectRoot: "/tmp/fake-project" };
const planFile = "scripts/steps/pipeline-plan/fixtures/worktree/plans/plan.json";

test("test_REVIEW_PLAN_PIPELINE_handsOffRunIdentityAndThePlanUnchanged", () => {
    const output = main(JSON.stringify({ ...base, planFile, clarifyRequest: null }));
    assert.deepEqual(output, { box: "REVIEW_PLAN_PIPELINE", scriptSignal: "continue", ...base, planFile, clarifyRequest: null });
});
