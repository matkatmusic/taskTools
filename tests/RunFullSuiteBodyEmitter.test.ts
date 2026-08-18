// Behavioral checks for scripts/tackle-tasks/RunFullSuiteBodyEmitter.ts. Run: node --test tests/RunFullSuiteBodyEmitter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFullSuitePrompt } from "../scripts/tackle-tasks/RunFullSuiteBodyEmitter.ts";
import type { PreparedTask } from "../scripts/tackle-tasks/preparedTask.ts";

const task: PreparedTask = {
    number: 35, briefFile: "/wt/plans/brief-35.md", planFile: "/wt/plans/plan.json",
    reviewFile: "/wt/plans/codex-review.json", reviewOutputFile: "/wt/plans/codex-review.json",
    testReviewFile: "/wt/plans/test-review.json", notesFile: "/wt/plans/implementation-notes-35.md",
    files: ["src/owned.ts"], ownedFilePaths: ["/wt/src/owned.ts"], testFilePaths: [],
    tests: null, codexReviewNotes: "", repoRoot: "/wt", taskStateRoot: "/project",
};

test("test_runFullSuitePrompt_carriesAValidStdinPayloadForRunFullSuite", () => {
    // The sandbox cannot run a script, so the whole box is the commands the agent runs.
    const prompt = runFullSuitePrompt(task, "r1", "main");
    const payload = prompt.match(/<<'TTPAYLOAD'[^\n]*\n(.*)\nTTPAYLOAD/)?.[1];
    assert.ok(payload, "prompt is missing the heredoc payload");
    assert.deepEqual(JSON.parse(payload), {
        taskNumber: 35, expectedRunId: "r1", worktreePath: "/wt",
        sourceBranch: "main", stepId: "run the full suite", projectRoot: "/project",
    });
});

test("test_runFullSuitePrompt_sendsTheRunToAGitignoredFileAndReadsTheVerdictBackFromIt", () => {
    // Reading the run's stdout directly hands back stepId, layers and 8000 chars of output too.
    const prompt = runFullSuitePrompt(task, "r1", "main");
    assert.match(prompt, /SUITE_FILE=\/wt\/plans\/full-suite-35\.json/);
    assert.match(prompt, /node \/.*\/runFullSuite\.ts <<'TTPAYLOAD' >"\$SUITE_FILE"/);
    assert.match(prompt, /node \/.*\/runFullSuite\.ts verdict "\$SUITE_FILE"/);
});

test("test_runFullSuitePrompt_leavesTheVerdictToTheScriptAndAsksForItVerbatim", () => {
    // This box derives nothing in prose; runFullSuite.ts decides, the agent relays.
    const prompt = runFullSuitePrompt(task, "r1", "main");
    assert.match(prompt, /Return the second command's output verbatim\./);
    assert.equal(prompt.includes("---- DATA ----"), false);
});
