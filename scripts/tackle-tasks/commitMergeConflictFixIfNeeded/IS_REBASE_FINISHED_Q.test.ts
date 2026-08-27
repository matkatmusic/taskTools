// Behavioral checks for IS_REBASE_FINISHED_Q.ts. Ported from pipeline-rebase's archived test, against the new packet contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./IS_REBASE_FINISHED_Q.ts";
import type { CommitMergeConflictFixIfNeededPacket } from "./_packet.ts";

const BASE: CommitMergeConflictFixIfNeededPacket = {
    box: "CONTINUE_REBASE", scriptSignal: "continue", taskNumber: 1, runId: "run-1", projectRoot: "/repo",
    worktree: "/repo/.worktrees/task-1", branch: "task-1", exitType: "", exitNote: "", message: "", additionalData: {},
    stoppedOccurrenceId: "", stoppedCheckoutPath: "", conflictedFilePaths: [], conflicted: false, finished: false, failureReason: "",
};

test("test_IS_REBASE_FINISHED_Q_routesToTheSuiteWhenFinished", () => {
    const output = main(JSON.stringify({ ...BASE, finished: true }));
    assert.equal(output.next, "pipeline-runFullSuite.mmd::RUN_FULL_SUITE");
});

test("test_IS_REBASE_FINISHED_Q_routesToTheConflictFixCounterWhenNotFinished", () => {
    const output = main(JSON.stringify({ ...BASE, finished: false }));
    assert.equal(output.next, "ARE_2_CONFLICT_FIXES_DONE_Q");
});
