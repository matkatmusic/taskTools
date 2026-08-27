import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./WAS_LOCK_ACQUIRED_Q.ts";

const BASE_INPUT = {
    runId: "run-a",
    taskNumber: 1,
    projectRoot: "/abs/project",
    worktree: "/abs/project/worktree",
    branch: "task-1",
    exitType: "",
    exitNote: "",
    lockWaitStartedAt: "2024-01-01T00:00:00.000Z",
    heldByOwner: "",
};

test("test_wasLockAcquired_routesToRebaseOntoTargetBranchWhenAcquired", () => {
    const result = main(JSON.stringify({ ...BASE_INPUT, acquired: true }));

    assert.equal(result.next, "pipeline-rebase.mmd::REBASE_ONTO_TARGET_BRANCH");
    assert.equal(result.box, "WAS_LOCK_ACQUIRED_Q");
    assert.equal(result.scriptSignal, "continue");
    assert.equal(result.runId, "run-a");
    assert.equal(result.taskNumber, 1);
    assert.equal(result.projectRoot, "/abs/project");
    assert.equal(result.worktree, "/abs/project/worktree");
    assert.equal(result.branch, "task-1");
    assert.equal(result.lockWaitStartedAt, "2024-01-01T00:00:00.000Z");
});

test("test_wasLockAcquired_routesToHave15MinutesPassedWhenNotAcquired", () => {
    const result = main(JSON.stringify({ ...BASE_INPUT, acquired: false }));

    assert.equal(result.next, "HAVE_15_MINUTES_PASSED_Q");
});
