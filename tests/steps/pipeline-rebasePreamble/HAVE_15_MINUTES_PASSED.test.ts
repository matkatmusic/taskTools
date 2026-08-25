// Run: node --test tests/steps/pipeline-rebasePreamble/HAVE_15_MINUTES_PASSED.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-rebasePreamble/HAVE_15_MINUTES_PASSED.ts";

const BASE_INPUT = { runId: "run-a", taskNumber: 1, projectRoot: "/abs/project" };

test("test_have15MinutesPassed_waitsAgainBeforeTheCap", () => {
    const lockWaitStartedAt = new Date(Date.now() - 60_000).toISOString();

    const result = main(JSON.stringify({ ...BASE_INPUT, lockWaitStartedAt }));

    assert.equal(result.next, "WAIT_FOR_LOCK");
    assert.equal(result.exitType, "");
    assert.equal(result.exitNote, "");
});

test("test_have15MinutesPassed_exitsRunFailedAfterTheCap", () => {
    const lockWaitStartedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();

    const result = main(JSON.stringify({ ...BASE_INPUT, lockWaitStartedAt }));

    assert.equal(result.next, "EXIT_WORKFLOW_REBASE_PREAMBLE");
    assert.equal(result.exitType, "run-failed");
    assert.equal(result.exitNote, "the source repo lock did not come free within 15 minutes");
});
