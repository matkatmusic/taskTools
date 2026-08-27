// Behavioral checks for ARE_2_TEST_REVIEWS_DONE_Q.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./ARE_2_TEST_REVIEWS_DONE_Q.ts";

function makeProjectRoot(codexReviewNotes: string): string {
    const root = mkdtempSync(join(tmpdir(), "are-2-test-reviews-done-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([
        { taskNumber: 99, files: ["src/thing.ts"], codexReviewNotes },
    ]));
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
    const projectRoot = makeProjectRoot("");
    const output = main(JSON.stringify(packetFor(projectRoot)));
    assert.equal(output.next, "AMEND_ENTRY_WITH_CODEX_NOTES");
    assert.equal(output.notes, "SENTINEL_NOTES");
    assert.equal(output.exitType, "");
    assert.equal(output.exitNote, "");
});

test("test_main_exitsOnASecondFlaggedReview", () => {
    // A non-empty codexReviewNotes means a prior flagged review already amended this entry once.
    const projectRoot = makeProjectRoot("A reviewer flagged the task tests. Apply every fix below.\n\nprior notes");
    const output = main(JSON.stringify(packetFor(projectRoot)));
    assert.equal(output.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(output.notes, "");
    assert.equal(output.exitType, "tests-flagged");
    assert.equal(output.exitNote, "task tests failed codex review");
});

test("test_main_throwsWhenTheTaskIsNotInTasksJson", () => {
    const projectRoot = makeProjectRoot("");
    const packet = { ...packetFor(projectRoot), taskNumber: 404 };
    assert.throws(() => main(JSON.stringify(packet)), /task 404 not found/);
});
