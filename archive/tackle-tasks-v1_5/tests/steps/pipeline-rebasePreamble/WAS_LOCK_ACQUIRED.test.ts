// Run: node --test tests/steps/pipeline-rebasePreamble/WAS_LOCK_ACQUIRED.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-rebasePreamble/WAS_LOCK_ACQUIRED.ts";

const BASE_INPUT = {
    runId: "run-a",
    taskNumber: 1,
    projectRoot: "/abs/project",
    lockWaitStartedAt: "2024-01-01T00:00:00.000Z",
};

test("test_wasLockAcquired_routesToRebasePipelineWhenAcquired", () => {
    const result = main(JSON.stringify({ ...BASE_INPUT, acquired: true }));

    assert.equal(result.next, "REBASE_PIPELINE");
    assert.equal(result.runId, "run-a");
    assert.equal(result.taskNumber, 1);
    assert.equal(result.projectRoot, "/abs/project");
    assert.equal(result.lockWaitStartedAt, "2024-01-01T00:00:00.000Z");
});

test("test_wasLockAcquired_routesToHave15MinutesPassedWhenNotAcquired", () => {
    const result = main(JSON.stringify({ ...BASE_INPUT, acquired: false }));

    assert.equal(result.next, "HAVE_15_MINUTES_PASSED");
});
