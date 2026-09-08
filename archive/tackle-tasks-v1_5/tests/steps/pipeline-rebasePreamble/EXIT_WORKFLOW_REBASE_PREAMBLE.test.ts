// Run: node --test tests/steps/pipeline-rebasePreamble/EXIT_WORKFLOW_REBASE_PREAMBLE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-rebasePreamble/EXIT_WORKFLOW_REBASE_PREAMBLE.ts";

test("test_exitWorkflowRebasePreamble_crossesIntoFailuresExitAndForwardsTheExitNote", () => {
    const result = main(JSON.stringify({
        runId: "run-a",
        taskNumber: 1,
        projectRoot: "/abs/project",
        worktreePath: "/abs/project/worktree",
        sourceBranch: "main",
        exitType: "run-failed",
        exitNote: "the source repo lock did not come free within 15 minutes",
    }));

    assert.equal(result.box, "EXIT_WORKFLOW_REBASE_PREAMBLE");
    assert.equal(result.scriptSignal, "continue");
    assert.equal(result.taskNumber, 1);
    assert.equal(result.runId, "run-a");
    assert.equal(result.projectRoot, "/abs/project");
    assert.equal(result.worktree, "/abs/project/worktree");
    assert.equal(result.sourceBranch, "main");
    assert.equal(result.exitType, "run-failed");
    assert.equal(result.exitNote, "the source repo lock did not come free within 15 minutes");
});
