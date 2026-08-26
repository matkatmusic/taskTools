// Behavioral checks for scripts/steps/pipeline-reviewTests/IMPLEMENT_PIPELINE.ts. Run: node --test tests/steps/pipeline-reviewTests/IMPLEMENT_PIPELINE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reviewTests/IMPLEMENT_PIPELINE.ts";

const core = {
    projectRoot: "/abs/project", taskNumber: 99, worktreePath: "/abs/project/worktree", sourceBranch: "main", runId: "run-1",
};

test("test_main_carriesTheCorePacketForwardDropsTheAmendReceiptAndAddsMaxFixRounds", () => {
    const input = { box: "AMEND_ENTRY_WITH_CODEX_NOTES", scriptSignal: "continue", ...core, amended: true };
    const output = main(JSON.stringify(input));
    assert.equal(output.box, "IMPLEMENT_PIPELINE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal("amended" in output, false);
    assert.equal(output.maxFixRounds, 3);
    for (const [key, value] of Object.entries(core)) assert.deepEqual(output[key], value);
});
