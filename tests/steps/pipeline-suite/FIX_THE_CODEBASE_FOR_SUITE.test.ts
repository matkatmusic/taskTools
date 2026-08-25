// Behavioral checks for scripts/steps/pipeline-suite/FIX_THE_CODEBASE_FOR_SUITE.ts.  Run: node --test tests/steps/pipeline-suite/FIX_THE_CODEBASE_FOR_SUITE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-suite/FIX_THE_CODEBASE_FOR_SUITE.ts";

function packet(): string {
    return JSON.stringify({
        taskNumber: 1, runId: "run-1", projectRoot: "/root", worktreePath: "/worktree", rootSourceBranch: "main",
        ownedFilePaths: ["/worktree/a.ts"], testFilePaths: ["/worktree/tests/a.test.ts"], suiteFixAttempts: 1,
        output: "the failing suite text",
    });
}

test("test_FIX_THE_CODEBASE_FOR_SUITE_printsThePromptContractShape", () => {
    const output = main(packet());
    assert.equal(output.box, "FIX_THE_CODEBASE_FOR_SUITE");
    assert.equal(output.scriptSignal, "prompt");
    assert.equal(typeof output.prompt, "string");
});

test("test_FIX_THE_CODEBASE_FOR_SUITE_namesTheOwnedFilesAndTheFailingOutput", () => {
    const output = main(packet());
    const prompt = String(output.prompt);
    assert.match(prompt, /\/worktree\/a\.ts/);
    assert.match(prompt, /the failing suite text/);
});

// The next block runs in a different agent() call; the engine carries the payload, not the prompt text.
test("test_FIX_THE_CODEBASE_FOR_SUITE_hasNoContinuationInstructions", () => {
    const output = main(packet());
    const prompt = String(output.prompt);
    assert.doesNotMatch(prompt, /\/run-step|invoke the skill/i);
});
