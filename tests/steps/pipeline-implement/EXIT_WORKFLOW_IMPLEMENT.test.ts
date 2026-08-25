// Behavioral checks for scripts/steps/pipeline-implement/EXIT_WORKFLOW_IMPLEMENT.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-implement/EXIT_WORKFLOW_IMPLEMENT.ts";

test("test_main_forwardsTheExitTypeAndNote", () => {
    const input = {
        box: "", scriptSignal: "continue", taskNumber: 42,
        projectRoot: "/abs/project", worktreePath: "/abs/project/.worktrees/task-42",
        runId: "run-1", sourceBranch: "main",
        exitType: "agent-failed", exitNote: "the agent returned nothing usable",
    };
    const output = main(JSON.stringify(input));
    assert.equal(output.box, "EXIT_WORKFLOW_IMPLEMENT");
    assert.equal(output.exitType, "agent-failed");
    assert.equal(output.exitNote, "the agent returned nothing usable");
    assert.equal(output.taskNumber, 42);
});
