// Behavioral checks for ARE_2_TEST_REVIEWS_DONE_Q.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./ARE_2_TEST_REVIEWS_DONE_Q.ts";
import { claimTask, raiseAttemptCount } from "../shared/taskRunState.ts";

function makeClaimedProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "are-2-test-reviews-done-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([
        { taskNumber: 99, files: ["src/thing.ts"], codexReviewNotes: "" },
    ]));
    const outcome = claimTask(99, "run-1", root);
    assert.equal(outcome.status, "claimed");
    return root;
}

function packetFor(projectRoot: string) {
    return {
        box: "ARE_TESTS_FLAGGED", scriptSignal: "continue", next: "ARE_2_TEST_REVIEWS_DONE_Q",
        taskNumber: 99, runId: "run-1", projectRoot, worktree: `${projectRoot}/worktree`, branch: "main",
        exitType: "", exitNote: "", flagged: true, notes: "SENTINEL_NOTES",
    };
}

test("test_main_routesToAmendOnTheFirstFlaggedReview", () => {
    const projectRoot = makeClaimedProjectRoot();
    const output = main(JSON.stringify(packetFor(projectRoot)));
    assert.equal(output.next, "AMEND_ENTRY_WITH_CODEX_NOTES");
    assert.equal(output.notes, "SENTINEL_NOTES");
    assert.equal(output.exitType, "");
    assert.equal(output.exitNote, "");
});

test("test_main_ignoresCodexReviewNotesLeftByOtherSteps", () => {
    // The plan reviewer and the failed-test step write the same field; neither is a test review.
    const projectRoot = makeClaimedProjectRoot();
    raiseAttemptCount(99, "run-1", "planReview", "pass-1", projectRoot);
    raiseAttemptCount(99, "run-1", "testFixes", "pass-2", projectRoot);
    const output = main(JSON.stringify(packetFor(projectRoot)));
    assert.equal(output.next, "AMEND_ENTRY_WITH_CODEX_NOTES");
});

test("test_main_exitsAfter2FlaggedReviews", () => {
    const projectRoot = makeClaimedProjectRoot();
    raiseAttemptCount(99, "run-1", "testReviews", "pass-1", projectRoot);
    raiseAttemptCount(99, "run-1", "testReviews", "pass-2", projectRoot);
    const output = main(JSON.stringify(packetFor(projectRoot)));
    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(output.notes, "");
    assert.equal(output.exitType, "tests-flagged");
    assert.equal(output.exitNote, "task tests failed codex review");
});
