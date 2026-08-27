// Behavioral checks for DID_REBASE_REPORT_CONFLICTS_Q.ts. Run: node --test scripts/tackle-tasks/rebase/DID_REBASE_REPORT_CONFLICTS_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./DID_REBASE_REPORT_CONFLICTS_Q.ts";
import type { RebasePacket } from "./_packet.ts";

const BASE: RebasePacket = {
    box: "REBASE_ONTO_TARGET_BRANCH", scriptSignal: "continue", taskNumber: 1, runId: "run-1",
    projectRoot: "/repo", worktree: "/repo/.worktrees/task-1", branch: "task-1", exitType: "", exitNote: "",
    conflicted: false, stoppedOccurrenceId: "", stoppedCheckoutPath: "", conflictedFilePaths: [], failureReason: "",
};

test("test_DID_REBASE_REPORT_CONFLICTS_Q_routesToTheConflictFixCounterWhenConflicted", () => {
    const output = main(JSON.stringify({ ...BASE, conflicted: true }));
    assert.equal(output.next, "ARE_2_CONFLICT_FIXES_DONE_Q");
    assert.equal(output.conflicted, true);
});

test("test_DID_REBASE_REPORT_CONFLICTS_Q_routesToTheSuiteWhenClean", () => {
    const output = main(JSON.stringify({ ...BASE, conflicted: false }));
    assert.equal(output.next, "pipeline-runFullSuite.mmd::RUN_FULL_SUITE");
});
