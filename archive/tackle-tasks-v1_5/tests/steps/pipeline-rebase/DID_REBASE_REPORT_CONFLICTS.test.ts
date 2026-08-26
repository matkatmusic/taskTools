// Behavioral checks for scripts/steps/pipeline-rebase/DID_REBASE_REPORT_CONFLICTS.ts.  Run: node --test tests/steps/pipeline-rebase/DID_REBASE_REPORT_CONFLICTS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-rebase/DID_REBASE_REPORT_CONFLICTS.ts";
import type { RebasePacket } from "../../../scripts/steps/pipeline-rebase/packet.ts";

const BASE: RebasePacket = {
    box: "REBASE_ONTO_TARGET_BRANCH", scriptSignal: "continue", projectRoot: "/repo",
    worktreePath: "/repo/.worktrees/task-1", taskNumber: 1, runId: "run-1", stepId: "step-1",
    rootSourceBranch: "main", landedOccurrenceIds: [], suiteFixAttempts: 0, conflicted: false, stoppedOccurrenceId: "",
    stoppedCheckoutPath: "", conflictedFilePaths: [], finished: false, failureReason: "",
    exitType: "", exitNote: "",
};

test("test_DID_REBASE_REPORT_CONFLICTS_routesToTheConflictFixCounterWhenConflicted", () => {
    const output = main(JSON.stringify({ ...BASE, conflicted: true }));
    assert.equal(output.next, "ARE_2_CONFLICT_FIXES_DONE");
    assert.equal(output.conflicted, true);
});

test("test_DID_REBASE_REPORT_CONFLICTS_routesToTheSuiteWhenClean", () => {
    const output = main(JSON.stringify({ ...BASE, conflicted: false }));
    assert.equal(output.next, "SUITE_PIPELINE");
});
