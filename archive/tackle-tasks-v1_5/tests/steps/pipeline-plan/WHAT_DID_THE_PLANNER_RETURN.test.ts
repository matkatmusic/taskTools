import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-plan/WHAT_DID_THE_PLANNER_RETURN.ts";

const base = { taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", sourceBranch: "master", projectRoot: "/tmp/fake-project" };
const planFile = "scripts/steps/pipeline-plan/fixtures/worktree/plans/plan.json";

test("test_WHAT_DID_THE_PLANNER_RETURN_routesPlanOutcomeToPlannerReturnedPlan", () => {
    const output = main(JSON.stringify({ ...base, outcome: "PLAN", planFile, clarifyRequest: null }));
    assert.equal(output.next, "PLANNER_RETURNED_PLAN");
    assert.equal(output.scriptSignal, "continue");
    assert.deepEqual(output.planFile, planFile);
});

test("test_WHAT_DID_THE_PLANNER_RETURN_routesClarifyOutcomeAndCarriesTheRequest", () => {
    const output = main(JSON.stringify({ ...base, outcome: "CLARIFY", planFile, clarifyRequest: "which database?" }));
    assert.equal(output.next, "PLANNER_RETURNED_CLARIFY");
    assert.equal(output.clarifyRequest, "which database?");
});

// ERROR is no longer a planner outcome: agent errors are the workflow loop's job, not a diagram box.
test("test_WHAT_DID_THE_PLANNER_RETURN_throwsOnAnUnknownOutcome", () => {
    assert.throws(() => main(JSON.stringify({ ...base, outcome: "ERROR", planFile, clarifyRequest: "" })), /unknown planner outcome/);
    assert.throws(() => main(JSON.stringify({ ...base, outcome: "MAYBE", planFile, clarifyRequest: "" })), /unknown planner outcome/);
});
