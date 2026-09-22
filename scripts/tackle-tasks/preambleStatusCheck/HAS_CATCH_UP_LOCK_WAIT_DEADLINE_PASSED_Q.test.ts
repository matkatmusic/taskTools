import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q.ts";

const BASE_INPUT = {
    runId: "run-a",
    taskNumber: 1,
    projectRoot: "/abs/project",
    worktree: "",
    branch: "task-1",
    docsMode: "",
    planFile: "",
    exitType: "",
    exitNote: "",
};

test("test_hasCatchUpLockWaitDeadlinePassed_waitsAgainBeforeTheCap", () => {
    // Setup: the wait started 60 seconds ago.
    const lockWaitStartedAt = new Date(Date.now() - 60_000).toISOString();

    // Test action: check the deadline.
    const result = main(JSON.stringify({ ...BASE_INPUT, lockWaitStartedAt }));

    // Verification: the walk waits again and sets no exit.
    assert.equal(result.next, "B_WAIT_FOR_CATCH_UP_LOCK");
    assert.equal(result.exitType, "");
    assert.equal(result.exitNote, "");
});

test("test_hasCatchUpLockWaitDeadlinePassed_exitsToReportOnlyAfterTheCap", () => {
    // Setup: the wait started 6 minutes ago.
    const lockWaitStartedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();

    // Test action: check the deadline.
    const result = main(JSON.stringify({ ...BASE_INPUT, lockWaitStartedAt }));

    // Verification: the walk leaves through REPORT_ONLY_EXIT, never FAILURES_EXIT.
    assert.equal(result.next, "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT");
    assert.equal(result.exitType, "catch-up-lock-timeout");
    assert.equal(result.exitNote, "the lock wait deadline passed");
});
