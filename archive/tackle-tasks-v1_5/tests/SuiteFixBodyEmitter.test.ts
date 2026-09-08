// Behavioral checks for scripts/tackle-tasks/SuiteFixBodyEmitter.ts. Run: node --test tests/SuiteFixBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suiteFixPrompt } from "../scripts/tackle-tasks/SuiteFixBodyEmitter.ts";
import type { PreparedTask } from "../scripts/tackle-tasks/preparedTask.ts";

// A project root whose tasks.json carries one run, so the emitter's state read has something to find.
function makeProjectRoot(fullSuite: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "suite-fix-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    const run = {
        runId: "r1", startedAt: "2026-08-18T00:00:00", endedAt: null, exitType: null, exitNote: null,
        modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite,
    };
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{
        taskNumber: 35, files: ["src/owned.ts"],
        run: { active: true, worktree: "/wt", leaseRunId: "r1", history: [run] },
    }]));
    return root;
}

const RED = { stepId: "run the full suite", layers: [{ occurrenceId: "", passed: false }], passed: false, output: "SENTINEL_FAILURE_OUTPUT", checkedAt: "2026-08-18T00:00:00" };

function makeTask(projectRoot: string): PreparedTask {
    return {
        number: 35, briefFile: "/wt/plans/brief-35.md", planFile: "/wt/plans/plan.json",
        reviewFile: "/wt/plans/codex-review.json", reviewOutputFile: "/wt/plans/codex-review.json",
        testReviewFile: "/wt/plans/test-review.json", notesFile: "/wt/plans/implementation-notes-35.md",
        files: ["src/owned.ts"], ownedFilePaths: ["/wt/src/owned.ts"], testFilePaths: [],
        hasTests: false, tests: null, codexReviewNotes: "", repoRoot: "/wt", taskStateRoot: projectRoot,
    };
}

test("test_suiteFixPrompt_derivesTheFailingOutputFromTaskRunStateNotFromTheCaller", () => {
    // The workflow passes testOutput: '' forever, so the emitter must read the recorded run itself.
    const prompt = suiteFixPrompt(makeTask(makeProjectRoot(RED)), "run-1", "main");
    assert.ok(prompt.includes("SENTINEL_FAILURE_OUTPUT"), "prompt is missing the recorded failing output");
});

test("test_suiteFixPrompt_throwsWhenNoFullSuiteRunIsRecorded", () => {
    // Running this box before the suite runs is a caller error, not an empty failure list.
    assert.throws(() => suiteFixPrompt(makeTask(makeProjectRoot(null)), "run-1", "main"), /no recorded full-suite run/);
});

test("test_suiteFixPrompt_throwsWhenTheRecordedSuitePassed", () => {
    // A green suite reaches the fence gate, never this box.
    const green = { ...RED, passed: true, layers: [{ occurrenceId: "", passed: true }] };
    assert.throws(() => suiteFixPrompt(makeTask(makeProjectRoot(green)), "run-1", "main"), /passed; this box runs only on a red suite/);
});

test("test_suiteFixPrompt_namesTheOwnedPathsAsTheCompleteEditAllowlistAndForbidsTests", () => {
    const prompt = suiteFixPrompt(makeTask(makeProjectRoot(RED)), "run-1", "main");
    assert.match(prompt, /## WHAT YOU MAY EDIT\n\n- `\/wt\/src\/owned\.ts`/);
    assert.match(prompt, /This list is complete\./);
    assert.match(prompt, /- edit a test file at all;/);
});

test("test_suiteFixPrompt_citesTheOutputTemplateAndCarriesNoDataBlock", () => {
    // The old prompt returned its shape from a trailing DATA block full of ALL_CAPS placeholders.
    const prompt = suiteFixPrompt(makeTask(makeProjectRoot(RED)), "run-1", "main");
    assert.match(prompt, /plans\/fix-suite-output-template\.json/);
    assert.equal(prompt.includes("---- DATA ----"), false);
});

test("test_suiteFixPrompt_tellsTheAgentToCommitViaTheScriptAsItsFinalStep", () => {
    // Rule 1 folded the commit into this box's own prompt instead of a separate committer box.
    const prompt = suiteFixPrompt(makeTask(makeProjectRoot(RED)), "run-1", "main");
    assert.match(prompt, /node \S*commitTaskWork\.ts <<'TTCOMMIT'/);
    assert.equal(prompt.includes("Leave every edit unstaged and uncommitted"), false);
    assert.match(prompt, /stage or commit anything by hand/);
});
