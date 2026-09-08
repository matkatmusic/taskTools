// Behavioral checks for IS_PLAN_APPROVED_BY_DEFAULT_Q.ts: only a task re-run after a scrapped-plan exit skips the review agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./IS_PLAN_APPROVED_BY_DEFAULT_Q.ts";
import { writeCheckpoint } from "../shared/checkpoint.ts";

function makePacket(worktree: string): string {
    return JSON.stringify({
        box: "WHAT_DID_THE_PLANNER_RETURN", scriptSignal: "continue", taskNumber: 42, runId: "run-1",
        projectRoot: worktree, worktree, branch: "task-42", planFile: join(worktree, "plans/plan.json"), exitType: "", exitNote: "",
    });
}

test("test_main_routesToCodexReviewWhenTheRunWasNotResumedFromAScrappedPlan", () => {
    const worktree = mkdtempSync(join(tmpdir(), "approved-by-default-no-"));
    const output = main(makePacket(worktree));
    assert.equal(output.next, "CODEX_REVIEWS_PLAN");
    assert.deepEqual(output.additionalData, { reviewFile: "" });
    assert.equal(existsSync(join(worktree, "plans/codex-review.json")), false);
});

test("test_main_writesAnApprovedReviewAndSkipsCodexOnTheReRunAfterAScrappedPlan", () => {
    const worktree = mkdtempSync(join(tmpdir(), "approved-by-default-yes-"));
    writeCheckpoint(worktree, {
        taskNumber: 42, passId: "p", runId: "run-1", projectRoot: worktree,
        block: "pipeline-codexReviewsPlan.mmd::IS_PLAN_APPROVED_BY_DEFAULT_Q", input: "", state: "running",
        sourceLockHeld: false, exitType: "", exitNote: "",
        resumedFrom: { block: "pipeline-whatIsReviewVerdict.mmd::TWO_CODEX_REVIEWS_COMPLETED_Q", exitType: "plan-scrapped", exitNote: "n" },
    });
    const output = main(makePacket(worktree));
    assert.equal(output.next, "pipeline-whatIsReviewVerdict.mmd::WHAT_IS_REVIEW_VERDICT");
    const reviewFile = join(worktree, "plans/codex-review.json");
    assert.deepEqual(output.additionalData, { reviewFile });
    assert.deepEqual(JSON.parse(readFileSync(reviewFile, "utf8")), { outcome: "OK", missingFiles: [], message: "", issues: [], fixes: [] });
});
