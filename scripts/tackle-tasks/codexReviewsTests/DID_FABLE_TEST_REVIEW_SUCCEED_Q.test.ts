// Behavioral checks for DID_FABLE_TEST_REVIEW_SUCCEED_Q.ts: routes to ARE_TESTS_FLAGGED on success, else to the opus fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./DID_FABLE_TEST_REVIEW_SUCCEED_Q.ts";

function makePacket(fableSucceeded: boolean) {
    return JSON.stringify({
        box: "CODEX_TEST_REVIEW_FALLBACK_FABLE", scriptSignal: "prompt", taskNumber: 1, runId: "run-1",
        projectRoot: "/wt", worktree: "/wt", branch: "task-1", exitType: "", exitNote: "",
        message: "", additionalData: { reviewFile: "/wt/plans/test-review.json", fableSucceeded },
    });
}

test("test_main_routesToAreTestsFlaggedWhenFableSucceeded", () => {
    const output = main(makePacket(true));
    assert.equal(output.next, "pipeline-areTestsFlagged.mmd::ARE_TESTS_FLAGGED");
    assert.deepEqual(output.additionalData, { reviewFile: "/wt/plans/test-review.json" });
});

test("test_main_routesToTheOpusFallbackWhenFableDidNotSucceed", () => {
    const output = main(makePacket(false));
    assert.equal(output.next, "CODEX_TEST_REVIEW_FALLBACK_OPUS");
    assert.deepEqual(output.additionalData, { reviewFile: "/wt/plans/test-review.json" });
});
