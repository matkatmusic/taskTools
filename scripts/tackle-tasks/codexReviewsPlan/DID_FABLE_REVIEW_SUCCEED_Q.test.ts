// Behavioral checks for DID_FABLE_REVIEW_SUCCEED_Q.ts: routes to the ruling on success, else to the opus fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./DID_FABLE_REVIEW_SUCCEED_Q.ts";

function makePacket(fableSucceeded: boolean) {
    return JSON.stringify({
        box: "CODEX_REVIEW_FALLBACK_FABLE", scriptSignal: "prompt", taskNumber: 42, runId: "run-1",
        projectRoot: "/wt", worktree: "/wt", branch: "task-42", planFile: "/wt/plans/plan.json", exitType: "", exitNote: "",
        message: "", additionalData: { reviewFile: "/wt/plans/codex-review.json", fableSucceeded },
    });
}

test("test_main_routesToWhatIsReviewVerdictWhenFableSucceeded", () => {
    const output = main(makePacket(true));
    assert.equal(output.next, "pipeline-whatIsReviewVerdict.mmd::WHAT_IS_REVIEW_VERDICT");
    assert.deepEqual(output.additionalData, { reviewFile: "/wt/plans/codex-review.json" });
});

test("test_main_routesToTheOpusFallbackWhenFableDidNotSucceed", () => {
    const output = main(makePacket(false));
    assert.equal(output.next, "CODEX_REVIEW_FALLBACK_OPUS");
    assert.deepEqual(output.additionalData, { reviewFile: "/wt/plans/codex-review.json" });
});
