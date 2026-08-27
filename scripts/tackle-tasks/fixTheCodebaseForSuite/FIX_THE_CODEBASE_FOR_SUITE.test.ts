// Behavioral checks for FIX_THE_CODEBASE_FOR_SUITE.ts. Run: node --test scripts/tackle-tasks/fixTheCodebaseForSuite/FIX_THE_CODEBASE_FOR_SUITE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./FIX_THE_CODEBASE_FOR_SUITE.ts";

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

test("test_FIX_THE_CODEBASE_FOR_SUITE_asksForFixSummaryInsideAdditionalData", () => {
    const worktree = mkdtempSync(join(tmpdir(), "fix-suite-"));
    main(packet(worktree));
    const promptFileContents = readFileSync(join(worktree, "plans", "FIX_THE_CODEBASE_FOR_SUITE.prompt.md"), "utf8");
    assert.match(promptFileContents, /"additionalData":\s*\{\s*"fixSummary"/);
});
