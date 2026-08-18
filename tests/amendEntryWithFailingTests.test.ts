// Behavioral checks for scripts/tackle-tasks/amendEntryWithFailingTests.ts. Run: node --test tests/amendEntryWithFailingTests.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { amendEntryWithFailingTests } from "../scripts/tackle-tasks/amendEntryWithFailingTests.ts";

// A project root whose task carries one recorded task-test run, which is what this box reads.
function makeProjectRoot(taskTests: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "amend-failing-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    const run = {
        runId: "r1", startedAt: "2026-08-18T00:00:00", endedAt: null, exitType: null, exitNote: null,
        modifiedFiles: [], commits: [], implementationNotesFile: null, fullSuite: null, taskTests,
    };
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 35, files: ["src/owned.ts"], codexReviewNotes: "",
        run: { active: true, worktree: "/wt", leaseRunId: "r1", history: [run] },
    }]));
    return root;
}

const RED = { stepId: "run task tests", testFiles: [], createdTestFiles: [], deletedTestFiles: [], missingTests: false, passed: false, output: "SENTINEL_FAILING_TESTS", checkedAt: "2026-08-18T00:00:00" };

const entryOf = (root: string) => JSON.parse(readFileSync(join(root, ".taskTools", "tasks.json"), "utf8"))[0];

test("test_amendEntryWithFailingTests_writesTheFailingOutputWhereTheImplementerReadsIt", () => {
    // implementPrompt takes its note from codexReviewNotes, so the reimplement loop is closed only if it lands there.
    const root = makeProjectRoot(RED);
    const output = amendEntryWithFailingTests({ projectRoot: root, taskNumber: 35 });
    assert.equal(output.amended, true);
    assert.match(entryOf(root).codexReviewNotes, /SENTINEL_FAILING_TESTS/);
    assert.match(entryOf(root).codexReviewNotes, /change no test/);
});

test("test_amendEntryWithFailingTests_throwsWhenNoTaskTestRunIsRecorded", () => {
    assert.throws(() => amendEntryWithFailingTests({ projectRoot: makeProjectRoot(null), taskNumber: 35 }), /no recorded task-test run/);
});

test("test_amendEntryWithFailingTests_throwsWhenTheRecordedTestsPassed", () => {
    // A green run goes to the review pipeline, never round the fix loop.
    const green = { ...RED, passed: true };
    assert.throws(() => amendEntryWithFailingTests({ projectRoot: makeProjectRoot(green), taskNumber: 35 }), /passed; this box runs only on red tests/);
});
