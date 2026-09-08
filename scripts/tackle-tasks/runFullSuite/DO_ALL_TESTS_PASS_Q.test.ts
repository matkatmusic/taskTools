// Behavioral checks for scripts/tackle-tasks/runFullSuite/DO_ALL_TESTS_PASS_Q.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./DO_ALL_TESTS_PASS_Q.ts";

function packet(passed: boolean): string {
    return JSON.stringify({
        taskNumber: 1, runId: "run-1", projectRoot: "/root", worktree: "/worktree",
        ownedFilePaths: [], readFilePaths: [], testFilePaths: [], passed, output: "suite output",
    });
}

test("test_DO_ALL_TESTS_PASS_Q_choosesTheFenceCheckWhenTheSuitePassed", () => {
    const output = main(packet(true));
    assert.equal(output.next, "DID_CHANGES_STAY_INSIDE_FENCE_Q");
});

test("test_DO_ALL_TESTS_PASS_Q_choosesTheFixAttemptGateWhenTheSuiteFailed", () => {
    const output = main(packet(false));
    assert.equal(output.next, "ARE_2_SUITE_FIXES_DONE_Q");
});
