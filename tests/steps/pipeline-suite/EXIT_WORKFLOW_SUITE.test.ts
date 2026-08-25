// Behavioral checks for scripts/steps/pipeline-suite/EXIT_WORKFLOW_SUITE.ts.
// Run: node --test tests/steps/pipeline-suite/EXIT_WORKFLOW_SUITE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-suite/EXIT_WORKFLOW_SUITE.ts";

test("test_EXIT_WORKFLOW_SUITE_forwardsTheIdentityAndExitFields", () => {
    const input = JSON.stringify({
        taskNumber: 1, runId: "run-1", projectRoot: "/root", worktreePath: "/worktree", rootSourceBranch: "main",
        exitType: "suite-red", exitNote: "full suite still red after 2 fix attempts. merge aborted. worktree preserved.",
    });
    const output = main(input);

    assert.equal(output.box, "EXIT_WORKFLOW_SUITE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.taskNumber, 1);
    assert.equal(output.exitType, "suite-red");
    assert.match(String(output.exitNote), /worktree preserved/);
});
