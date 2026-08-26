// Behavioral checks for scripts/steps/pipeline-rebase/EXIT_WORKFLOW_REBASE.ts.  Run: node --test tests/steps/pipeline-rebase/EXIT_WORKFLOW_REBASE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-rebase/EXIT_WORKFLOW_REBASE.ts";

test("test_EXIT_WORKFLOW_REBASE_forwardsTheIdentityAndExitFields", () => {
    const input = JSON.stringify({
        taskNumber: 1, runId: "run-1", projectRoot: "/repo", worktreePath: "/repo/.worktrees/task-1",
        rootSourceBranch: "main", exitType: "rebase-stuck", exitNote: "the rebase did not advance after 2 conflict fixes",
    });
    const output = main(input);

    assert.deepEqual(output, {
        box: "EXIT_WORKFLOW_REBASE",
        scriptSignal: "continue",
        taskNumber: 1,
        runId: "run-1",
        projectRoot: "/repo",
        worktree: "/repo/.worktrees/task-1",
        sourceBranch: "main",
        exitType: "rebase-stuck",
        exitNote: "the rebase did not advance after 2 conflict fixes",
    });
});

test("test_EXIT_WORKFLOW_REBASE_forwardsAnAgentFailedExitJustAsWell", () => {
    const input = JSON.stringify({
        taskNumber: 1, runId: "run-1", projectRoot: "/repo", worktreePath: "/repo/.worktrees/task-1",
        rootSourceBranch: "main", exitType: "agent-failed", exitNote: "the agent returned nothing usable",
    });
    const output = main(input);

    assert.equal(output.exitType, "agent-failed");
    assert.equal(output.exitNote, "the agent returned nothing usable");
});
