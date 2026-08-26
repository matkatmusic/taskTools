// Behavioral checks for scripts/steps/pipeline-suite/ARE_2_SUITE_FIXES_DONE.ts.
// Run: node --test tests/steps/pipeline-suite/ARE_2_SUITE_FIXES_DONE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-suite/ARE_2_SUITE_FIXES_DONE.ts";

function packet(suiteFixAttempts: number): string {
    return JSON.stringify({
        taskNumber: 1, runId: "run-1", projectRoot: "/root", worktreePath: "/worktree", rootSourceBranch: "main",
        ownedFilePaths: [], testFilePaths: [], suiteFixAttempts, output: "failing output",
    });
}

test("test_ARE_2_SUITE_FIXES_DONE_sendsTheFirstAttemptToTheFixAgentAndRaisesTheCounter", () => {
    const output = main(packet(0));
    assert.equal(output.next, "FIX_THE_CODEBASE_FOR_SUITE");
    assert.equal(output.suiteFixAttempts, 1);
    assert.equal(output.exitType, "");
});

test("test_ARE_2_SUITE_FIXES_DONE_sendsTheSecondAttemptToTheFixAgentAndRaisesTheCounter", () => {
    const output = main(packet(1));
    assert.equal(output.next, "FIX_THE_CODEBASE_FOR_SUITE");
    assert.equal(output.suiteFixAttempts, 2);
});

test("test_ARE_2_SUITE_FIXES_DONE_exitsAsSuiteRedAfterTwoAttempts", () => {
    const output = main(packet(2));
    assert.equal(output.next, "EXIT_WORKFLOW_SUITE");
    assert.equal(output.exitType, "suite-red");
    assert.match(String(output.exitNote), /2 fix attempts/);
    assert.equal(output.suiteFixAttempts, 2);
});
