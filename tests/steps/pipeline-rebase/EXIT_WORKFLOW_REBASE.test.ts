// Behavioral checks for scripts/steps/pipeline-rebase/EXIT_WORKFLOW_REBASE.ts.  Run: node --test tests/steps/pipeline-rebase/EXIT_WORKFLOW_REBASE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-rebase/EXIT_WORKFLOW_REBASE.ts";
import type { RebasePacket } from "../../../scripts/steps/pipeline-rebase/packet.ts";

const BASE: RebasePacket = {
    box: "ARE_2_CONFLICT_FIXES_DONE", scriptSignal: "continue", projectRoot: "/repo",
    worktreePath: "/repo/.worktrees/task-1", taskNumber: 1, runId: "run-1", stepId: "step-1",
    rootSourceBranch: "main", landedOccurrenceIds: [], suiteFixAttempts: 0, conflicted: true, stoppedOccurrenceId: "",
    stoppedCheckoutPath: "/repo/.worktrees/task-1", conflictedFilePaths: ["a.txt"], finished: false,
    failureReason: "", exitType: "rebase-stuck", exitNote: "the rebase did not advance after 2 conflict fixes",
};

test("test_EXIT_WORKFLOW_REBASE_forwardsTheExitTypeAndNoteUnchanged", () => {
    const output = main(JSON.stringify(BASE));
    assert.equal(output.box, "EXIT_WORKFLOW_REBASE");
    assert.equal(output.exitType, "rebase-stuck");
    assert.equal(output.exitNote, "the rebase did not advance after 2 conflict fixes");
});

test("test_EXIT_WORKFLOW_REBASE_forwardsAnAgentFailedExitJustAsWell", () => {
    const output = main(JSON.stringify({ ...BASE, exitType: "agent-failed", exitNote: "the agent returned nothing usable" }));
    assert.equal(output.exitType, "agent-failed");
    assert.equal(output.exitNote, "the agent returned nothing usable");
});
