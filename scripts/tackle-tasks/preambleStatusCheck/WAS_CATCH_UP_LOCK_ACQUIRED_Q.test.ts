import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./WAS_CATCH_UP_LOCK_ACQUIRED_Q.ts";

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
    lockWaitStartedAt: "2024-01-01T00:00:00.000Z",
    heldByOwner: "",
};

test("test_wasCatchUpLockAcquired_routesToCatchUpStagingWhenAcquired", () => {
    // Test action: the lock was taken.
    const result = main(JSON.stringify({ ...BASE_INPUT, acquired: true }));

    // Verification: the walk goes on to the catch-up.
    assert.equal(result.next, "Q_CATCH_UP_STAGING");
    assert.equal(result.box, "Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q");
});

test("test_wasCatchUpLockAcquired_routesToHasCatchUpLockWaitDeadlinePassedWhenNotAcquired", () => {
    // Test action: another run holds the lock.
    const result = main(JSON.stringify({ ...BASE_INPUT, acquired: false }));

    // Verification: the walk checks the wait deadline.
    assert.equal(result.next, "Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q");
});
