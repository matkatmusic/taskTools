// Behavioral checks for scripts/steps/pipeline-suite/FIX_THE_CODEBASE_FOR_SUITE.ts.  Run: node --test tests/steps/pipeline-suite/FIX_THE_CODEBASE_FOR_SUITE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-suite/FIX_THE_CODEBASE_FOR_SUITE.ts";

function packet(worktreePath: string): string {
    return JSON.stringify({
        taskNumber: 1, runId: "run-1", projectRoot: "/root", worktreePath, rootSourceBranch: "main",
        ownedFilePaths: [`${worktreePath}/a.ts`], testFilePaths: [`${worktreePath}/tests/a.test.ts`], suiteFixAttempts: 1,
        output: "the failing suite text",
    });
}

test("test_FIX_THE_CODEBASE_FOR_SUITE_printsThePromptContractShape", () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "fix-suite-"));
    const output = main(packet(worktreePath));
    assert.equal(output.box, "FIX_THE_CODEBASE_FOR_SUITE");
    assert.equal(output.scriptSignal, "prompt");
    assert.equal(typeof output.prompt, "string");
});

test("test_FIX_THE_CODEBASE_FOR_SUITE_namesTheOwnedFilesAndTheFailingOutput", () => {
    const worktreePath = mkdtempSync(join(tmpdir(), "fix-suite-"));
    main(packet(worktreePath));
    const promptFileContents = readFileSync(join(worktreePath, "plans", "FIX_THE_CODEBASE_FOR_SUITE.prompt.md"), "utf8");
    assert.match(promptFileContents, new RegExp(`${worktreePath}/a\\.ts`));
    assert.match(promptFileContents, /the failing suite text/);
});
