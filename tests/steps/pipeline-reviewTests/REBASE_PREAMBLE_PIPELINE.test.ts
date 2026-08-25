// Behavioral checks for scripts/steps/pipeline-reviewTests/REBASE_PREAMBLE_PIPELINE.ts. Run: node --test tests/steps/pipeline-reviewTests/REBASE_PREAMBLE_PIPELINE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewTests/REBASE_PREAMBLE_PIPELINE.ts";

const core = {
    projectRoot: "/abs/project", taskNumber: 99, worktree: "/abs/project/worktree", sourceBranch: "main",
    planFile: "/abs/project/worktree/plans/plan.json", testFilePaths: ["/abs/project/worktree/tests/thing.test.ts"],
    testCommand: "node --test tests/thing.test.ts", testOutput: "ok",
};

test("test_main_carriesTheCorePacketForwardAndDropsReviewFields", () => {
    const input = { box: "ARE_TESTS_FLAGGED", scriptSignal: "continue", next: "REBASE_PREAMBLE_PIPELINE", ...core, notes: "" };
    const output = main(JSON.stringify(input));
    assert.equal(output.box, "REBASE_PREAMBLE_PIPELINE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal("notes" in output, false);
    assert.equal("next" in output, false);
    for (const [key, value] of Object.entries(core)) assert.deepEqual(output[key], value);
});
