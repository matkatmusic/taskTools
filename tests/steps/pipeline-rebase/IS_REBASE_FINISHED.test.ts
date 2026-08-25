// Behavioral checks for scripts/steps/pipeline-rebase/IS_REBASE_FINISHED.ts.  Run: node --test tests/steps/pipeline-rebase/IS_REBASE_FINISHED.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-rebase/IS_REBASE_FINISHED.ts";
import type { RebasePacket } from "../../../scripts/steps/pipeline-rebase/packet.ts";

const BASE: RebasePacket = {
    box: "CONTINUE_REBASE", scriptSignal: "continue", projectRoot: "/repo",
    worktreePath: "/repo/.worktrees/task-1", taskNumber: 1, runId: "run-1", stepId: "step-1",
    rootSourceBranch: "main", landedOccurrenceIds: [], suiteFixAttempts: 0, conflicted: false, stoppedOccurrenceId: "",
    stoppedCheckoutPath: "", conflictedFilePaths: [], finished: false, failureReason: "",
    exitType: "", exitNote: "",
};

test("test_IS_REBASE_FINISHED_routesToTheSuiteWhenFinished", () => {
    const output = main(JSON.stringify({ ...BASE, finished: true }));
    assert.equal(output.next, "SUITE_PIPELINE");
});

test("test_IS_REBASE_FINISHED_loopsBackToTheConflictCheckWhenNotFinished", () => {
    const output = main(JSON.stringify({ ...BASE, finished: false }));
    assert.equal(output.next, "DID_REBASE_REPORT_CONFLICTS");
});
