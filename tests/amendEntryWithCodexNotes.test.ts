// Behavioral checks for scripts/tackle-tasks/amendEntryWithCodexNotes.ts. Run: node --test tests/amendEntryWithCodexNotes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amendEntryWithCodexNotes } from "../scripts/tackle-tasks/amendEntryWithCodexNotes.ts";
import type { TestReview } from "../scripts/tackle-tasks/decideTestReview.ts";

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "amend-codex-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([
        { taskNumber: 35, files: ["src/owned.ts"], codexReviewNotes: "" },
    ]));
    return root;
}

const clean: TestReview = { outcome: "OK", missingFiles: [], message: "", issues: [], testsThatHoldUp: [] };
const flagged: TestReview = { ...clean, issues: [{ testFile: "tests/thing.test.ts", testName: "t", evidence: "tests/thing.test.ts:1-9", problem: "SENTINEL_PROBLEM", fix: "SENTINEL_FIX" }] };

const entryOf = (root: string) => JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"))[0];

test("test_amendEntryWithCodexNotes_writesEveryProblemAndFixWhereTheImplementerReadsThem", () => {
    const root = makeProjectRoot();
    const output = amendEntryWithCodexNotes({ projectRoot: root, taskNumber: 35, review: flagged });
    assert.equal(output.amended, true);
    assert.match(entryOf(root).codexReviewNotes, /SENTINEL_PROBLEM/);
    assert.match(entryOf(root).codexReviewNotes, /SENTINEL_FIX/);
});

test("test_amendEntryWithCodexNotes_rulesWithTheSameScriptTheReviewBoxUsed", () => {
    // A second opinion here would let the entry and the review receipt disagree about what was flagged.
    assert.throws(() => amendEntryWithCodexNotes({ projectRoot: makeProjectRoot(), taskNumber: 35, review: clean }), /flagged nothing/);
});

test("test_amendEntryWithCodexNotes_treatsAnUnreadableReviewAsFlagged", () => {
    const root = makeProjectRoot();
    const review: TestReview = { ...clean, outcome: "ERROR", missingFiles: ["/wt/plans/plan.json"], message: "not performed." };
    amendEntryWithCodexNotes({ projectRoot: root, taskNumber: 35, review });
    assert.match(entryOf(root).codexReviewNotes, /missing: \/wt\/plans\/plan\.json/);
});
