import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./HAS_LOCK_WAIT_DEADLINE_PASSED_Q.ts";

const BASE_INPUT = {
    runId: "run-a",
    taskNumber: 1,
    projectRoot: "/abs/project",
    worktree: "/abs/project/worktree",
    branch: "task-1",
    exitType: "",
    exitNote: "",
};

test("test_hasLockWaitDeadlinePassed_waitsAgainBeforeTheCap", () => {
    const lockWaitStartedAt = new Date(Date.now() - 60_000).toISOString();

    const result = main(JSON.stringify({ ...BASE_INPUT, lockWaitStartedAt }));

    assert.equal(result.next, "WAIT_FOR_LOCK");
    assert.equal(result.exitType, "");
    assert.equal(result.exitNote, "");
});

test("test_hasLockWaitDeadlinePassed_exitsRunFailedAfterTheCap", () => {
    const lockWaitStartedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();

    const result = main(JSON.stringify({ ...BASE_INPUT, lockWaitStartedAt }));

    assert.equal(result.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(result.exitType, "run-failed");
    assert.equal(result.exitNote, "the source repo lock did not come free within 5 minutes");
});

test("test_hasLockWaitDeadlinePassed_exitsRunFailedBeforeTheOldFifteenMinuteCap", () => {
    const lockWaitStartedAt = new Date(Date.now() - 9 * 60 * 1000).toISOString();

    const result = main(JSON.stringify({ ...BASE_INPUT, lockWaitStartedAt }));

    assert.equal(result.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(result.exitType, "run-failed");
});
