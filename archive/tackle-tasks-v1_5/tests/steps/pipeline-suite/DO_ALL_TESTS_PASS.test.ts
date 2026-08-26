// Behavioral checks for scripts/steps/pipeline-suite/DO_ALL_TESTS_PASS.ts.
// Run: node --test tests/steps/pipeline-suite/DO_ALL_TESTS_PASS.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-suite/DO_ALL_TESTS_PASS.ts";

function packet(passed: boolean): string {
    return JSON.stringify({
        taskNumber: 1, runId: "run-1", projectRoot: "/root", worktreePath: "/worktree", rootSourceBranch: "main",
        ownedFilePaths: [], testFilePaths: [], suiteFixAttempts: 0, passed, output: "suite output",
    });
}

test("test_DO_ALL_TESTS_PASS_choosesTheFenceCheckWhenTheSuitePassed", () => {
    const output = main(packet(true));
    assert.equal(output.next, "DID_CHANGES_STAY_INSIDE_FENCE");
});

test("test_DO_ALL_TESTS_PASS_choosesTheFixAttemptGateWhenTheSuiteFailed", () => {
    const output = main(packet(false));
    assert.equal(output.next, "ARE_2_SUITE_FIXES_DONE");
});
