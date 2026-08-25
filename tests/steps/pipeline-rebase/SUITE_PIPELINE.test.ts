// Behavioral checks for scripts/steps/pipeline-rebase/SUITE_PIPELINE.ts.  Run: node --test tests/steps/pipeline-rebase/SUITE_PIPELINE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-rebase/SUITE_PIPELINE.ts";
import type { RebasePacket } from "../../../scripts/steps/pipeline-rebase/packet.ts";

const BASE: RebasePacket = {
    box: "IS_REBASE_FINISHED", scriptSignal: "continue", projectRoot: "/repo",
    worktreePath: "/repo/.worktrees/task-1", taskNumber: 1, runId: "run-1", stepId: "step-1",
    rootSourceBranch: "main", landedOccurrenceIds: [], suiteFixAttempts: 0, conflicted: false, stoppedOccurrenceId: "",
    stoppedCheckoutPath: "", conflictedFilePaths: [], finished: true, failureReason: "",
    exitType: "", exitNote: "",
};

test("test_SUITE_PIPELINE_handsThePacketOnUnchangedForTheNextDiagram", () => {
    const output = main(JSON.stringify(BASE));
    assert.equal(output.box, "SUITE_PIPELINE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.worktreePath, BASE.worktreePath);
    assert.equal(output.finished, true);
});
