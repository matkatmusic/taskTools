// Sets WAIT_FOR_LOCK_MS=20 before the import, so the test does not spend 5 real seconds.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.WAIT_FOR_LOCK_MS = "20";
const { main } = await import("./WAIT_FOR_CATCH_UP_LOCK.ts");

test("test_waitForCatchUpLock_waitsThenLoopsBackToLockStagingForCatchUp", () => {
    // Test action: wait once, timing the call.
    const startedAt = Date.now();
    const result = main(JSON.stringify({
        box: "Q_HAS_CATCH_UP_LOCK_WAIT_DEADLINE_PASSED_Q",
        scriptSignal: "continue",
        next: "B_WAIT_FOR_CATCH_UP_LOCK",
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
    }));
    const elapsedMs = Date.now() - startedAt;

    // Verification: it waited, and it leaves the loop-back to the diagram's one edge.
    assert.ok(elapsedMs >= 20, `waited only ${elapsedMs}ms`);
    assert.equal(result.box, "B_WAIT_FOR_CATCH_UP_LOCK");
    assert.equal(result.scriptSignal, "continue");
    assert.equal("next" in result, false);
});
