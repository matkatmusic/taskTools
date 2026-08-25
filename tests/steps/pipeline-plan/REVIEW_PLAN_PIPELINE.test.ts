import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-plan/REVIEW_PLAN_PIPELINE.ts";

const base = { taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", sourceBranch: "master", projectRoot: "/tmp/fake-project" };
const samplePlan = { task: 35, revision: 1, createsFiles: [], sections: [{ id: "sentinel-step", title: "sentinel", body: "sentinel body", codexNotes: "" }] };

test("test_REVIEW_PLAN_PIPELINE_handsOffRunIdentityAndThePlanUnchanged", () => {
    const output = main(JSON.stringify({ ...base, plan: samplePlan, clarifyRequest: null }));
    assert.deepEqual(output, { box: "REVIEW_PLAN_PIPELINE", scriptSignal: "continue", ...base, plan: samplePlan, clarifyRequest: null });
});
