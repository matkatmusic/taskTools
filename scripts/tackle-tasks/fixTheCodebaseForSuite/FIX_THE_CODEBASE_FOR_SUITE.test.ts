// Behavioral checks for FIX_THE_CODEBASE_FOR_SUITE.ts. Run: node --test scripts/tackle-tasks/fixTheCodebaseForSuite/FIX_THE_CODEBASE_FOR_SUITE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, buildSuiteFixPromptSkeleton, suiteFixChoices } from "./FIX_THE_CODEBASE_FOR_SUITE.ts";

process.env.RUN_STEP_LOG = join(tmpdir(), "fix-the-codebase-for-suite-run-log.json");

function packet(worktree: string): string {
    return JSON.stringify({
        box: "ARE_2_SUITE_FIXES_DONE_Q", scriptSignal: "continue",
        taskNumber: 1, runId: "run-1", projectRoot: "/root", worktree, branch: "main",
        exitType: "", exitNote: "",
        ownedFilePaths: [`${worktree}/a.ts`], testFilePaths: [`${worktree}/tests/a.test.ts`],
        output: "the failing suite text",
    });
}

test("test_FIX_THE_CODEBASE_FOR_SUITE_printsThePromptContractShape", () => {
    const worktree = mkdtempSync(join(tmpdir(), "fix-suite-"));
    const output = main(packet(worktree));
    assert.equal(output.box, "FIX_THE_CODEBASE_FOR_SUITE");
    assert.equal(output.scriptSignal, "prompt");
    assert.equal(typeof output.prompt, "string");
});

test("test_FIX_THE_CODEBASE_FOR_SUITE_namesTheOwnedFilesAndTheFailingOutput", () => {
    const worktree = mkdtempSync(join(tmpdir(), "fix-suite-"));
    main(packet(worktree));
    const promptFileContents = readFileSync(join(worktree, "plans", "FIX_THE_CODEBASE_FOR_SUITE.prompt.md"), "utf8");
    assert.match(promptFileContents, new RegExp(`${worktree}/a\\.ts`));
    assert.match(promptFileContents, /the failing suite text/);
});

test("test_buildSuiteFixPromptSkeleton_holdsAllTheSectionsSinceThereAreNoChoices", () => {
    const skeleton = buildSuiteFixPromptSkeleton(suiteFixChoices());
    for (const header of ["## YOUR JOB", "## WHAT TO READ", "## WHAT YOU MAY EDIT", "## HOW TO FIX", "## FORBIDDEN ACTIONS", "`${whatToReturnSection(...)}`", "## FAILING SUITE OUTPUT"]) {
        assert.ok(skeleton.includes(header), `missing "${header}"`);
    }
});

test("test_FIX_THE_CODEBASE_FOR_SUITE_runsTwiceWithTheSameInput", () => {
    const worktree = mkdtempSync(join(tmpdir(), "fix-suite-"));
    const input = packet(worktree);

    const first = main(input);
    const promptAfterFirst = readFileSync(join(worktree, "plans", "FIX_THE_CODEBASE_FOR_SUITE.prompt.md"), "utf8");

    const second = main(input);
    const promptAfterSecond = readFileSync(join(worktree, "plans", "FIX_THE_CODEBASE_FOR_SUITE.prompt.md"), "utf8");

    assert.deepEqual(second, first);
    assert.equal(promptAfterSecond, promptAfterFirst);
});

test("test_FIX_THE_CODEBASE_FOR_SUITE_asksForFixSummaryInsideAdditionalData", () => {
    const worktree = mkdtempSync(join(tmpdir(), "fix-suite-"));
    main(packet(worktree));
    const promptFileContents = readFileSync(join(worktree, "plans", "FIX_THE_CODEBASE_FOR_SUITE.prompt.md"), "utf8");
    assert.match(promptFileContents, /"additionalData":\s*\{\s*"fixSummary"/);
});
