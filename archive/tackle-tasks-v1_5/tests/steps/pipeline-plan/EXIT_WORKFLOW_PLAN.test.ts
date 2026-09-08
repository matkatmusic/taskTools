import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-plan/EXIT_WORKFLOW_PLAN.ts";

const base = { taskNumber: 35, runId: "run-1", worktree: "/tmp/fake-worktree", sourceBranch: "master", projectRoot: "/tmp/fake-project" };

test("test_EXIT_WORKFLOW_PLAN_forwardsTheExitTypeAndNote", () => {
    const output = main(JSON.stringify({ ...base, exitType: "clarify-stuck", exitNote: "the planner asked twice for something the docs cannot supply. worktree preserved." }));
    assert.deepEqual(output, {
        box: "EXIT_WORKFLOW_PLAN", scriptSignal: "continue",
        taskNumber: base.taskNumber, runId: base.runId, projectRoot: base.projectRoot, worktree: base.worktree,
        sourceBranch: base.sourceBranch,
        exitType: "clarify-stuck", exitNote: "the planner asked twice for something the docs cannot supply. worktree preserved.",
    });
});

test("test_EXIT_WORKFLOW_PLAN_alsoForwardsAnAgentFailedExit", () => {
    const output = main(JSON.stringify({ ...base, exitType: "agent-failed", exitNote: "the agent returned nothing usable" }));
    assert.equal(output.exitType, "agent-failed");
});
