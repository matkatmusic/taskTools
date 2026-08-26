import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-plan/PLANNER_RETURNED_CLARIFY.ts";

const base = { taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", sourceBranch: "master", projectRoot: "/tmp/fake-project" };

test("test_PLANNER_RETURNED_CLARIFY_carriesTheClarifyRequestForward", () => {
    const output = main(JSON.stringify({ ...base, clarifyRequest: "which database?", next: "PLANNER_RETURNED_CLARIFY" }));
    assert.deepEqual(output, { box: "PLANNER_RETURNED_CLARIFY", scriptSignal: "continue", ...base, clarifyRequest: "which database?" });
});
