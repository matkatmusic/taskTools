// Behavioral checks for ARE_TESTS_FLAGGED.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./ARE_TESTS_FLAGGED.ts";

const core = {
    taskNumber: 99, runId: "run-1", projectRoot: "/abs/project", worktree: "/abs/project/worktree",
    branch: "main", exitType: "", exitNote: "",
};

const clean = { outcome: "OK", missingFiles: [], message: "", issues: [], testsThatHoldUp: ["a test"] };
const issue = { testFile: "tests/thing.test.ts", testName: "a test", evidence: "tests/thing.test.ts:1-9", problem: "asserts nothing", fix: "assert the return value" };

function writeReviewFile(review: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "are-tests-flagged-"));
    const path = join(dir, "test-review.json");
    writeFileSync(path, JSON.stringify(review));
    return path;
}

function inputFor(reviewFile: string) {
    return { box: "CODEX_REVIEWS_TESTS", scriptSignal: "continue", ...core, message: "", additionalData: { reviewFile } };
}

test("test_main_routesToLockSourceRepoWhenNotFlagged", () => {
    const output = main(JSON.stringify(inputFor(writeReviewFile(clean))));
    assert.equal(output.next, "pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO");
    assert.equal(output.notes, "");
    assert.equal(output.flagged, false);
});

test("test_main_routesToAre2TestReviewsDoneWhenFlagged", () => {
    const output = main(JSON.stringify(inputFor(writeReviewFile({ ...clean, issues: [issue] }))));
    assert.equal(output.next, "ARE_2_TEST_REVIEWS_DONE_Q");
    assert.match(output.notes as string, /asserts nothing/);
    assert.match(output.notes as string, /Fix: assert the return value/);
    assert.equal(output.flagged, true);
});

test("test_main_carriesTheCorePacketThrough", () => {
    const output = main(JSON.stringify(inputFor(writeReviewFile({ ...clean, issues: [issue] }))));
    for (const [key, value] of Object.entries(core)) assert.deepEqual(output[key], value);
});
