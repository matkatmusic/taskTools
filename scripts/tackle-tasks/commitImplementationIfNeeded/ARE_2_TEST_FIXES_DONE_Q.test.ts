// Behavioral checks for ARE_2_TEST_FIXES_DONE_Q.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./ARE_2_TEST_FIXES_DONE_Q.ts";
import { claimTask, raiseAttemptCount } from "../shared/taskRunState.ts";

function makeClaimedProjectRoot(taskNumber: number): string {
    const root = mkdtempSync(join(tmpdir(), "are-2-test-fixes-done-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "t" }]));
    const outcome = claimTask(taskNumber, "run-1", root);
    assert.equal(outcome.status, "claimed");
    return root;
}

function packet(projectRoot: string, taskNumber: number) {
    return { box: "DO_TASK_TESTS_PASS_Q", scriptSignal: "continue", taskNumber, runId: "run-1", projectRoot, worktree: "/abs/worktree", branch: "task-1", exitType: "", exitNote: "" };
}

test("test_main_continuesToAmendWhenNoFixHasBeenAttempted", () => {
    const root = makeClaimedProjectRoot(1);
    const input = packet(root, 1);
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, { ...input, box: "ARE_2_TEST_FIXES_DONE_Q", exitType: "", exitNote: "", next: "AMEND_ENTRY_WITH_FAILING_TESTS" });
});

test("test_main_exitsTestsRedAfter2Attempts", () => {
    const root = makeClaimedProjectRoot(2);
    raiseAttemptCount(2, "run-1", "testFixes", "pass-1", root);
    raiseAttemptCount(2, "run-1", "testFixes", "pass-2", root);
    const input = packet(root, 2);
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, {
        ...input, box: "ARE_2_TEST_FIXES_DONE_Q",
        exitType: "tests-red", exitNote: "task tests still failing after 2 fix attempts",
        next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
    });
});
