// Run: WAIT_FOR_LOCK_MS=20 node --test scripts/tackle-tasks/lockSourceRepo/WAIT_FOR_LOCK.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.WAIT_FOR_LOCK_MS = "20";
const { main } = await import("./WAIT_FOR_LOCK.ts");

test("test_waitForLock_waitsThenLoopsBackToLockSourceRepo", () => {
    const startedAt = Date.now();
    const result = main(JSON.stringify({
        runId: "run-a",
        taskNumber: 1,
        projectRoot: "/abs/project",
        worktree: "/abs/project/worktree",
        branch: "task-1",
        exitType: "",
        exitNote: "",
        lockWaitStartedAt: "2024-01-01T00:00:00.000Z",
    }));
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs >= 20, `waited only ${elapsedMs}ms`);
    assert.equal(result.box, "WAIT_FOR_LOCK");
    assert.equal(result.scriptSignal, "continue");
    assert.equal(result.runId, "run-a");
    assert.equal(result.taskNumber, 1);
    assert.equal(result.projectRoot, "/abs/project");
    assert.equal(result.worktree, "/abs/project/worktree");
    assert.equal(result.branch, "task-1");
    assert.equal(result.lockWaitStartedAt, "2024-01-01T00:00:00.000Z");
});
