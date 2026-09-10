// Behavioral checks for ARE_2_TEST_FIXES_DONE_Q.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, resetScope } from "./ARE_2_TEST_FIXES_DONE_Q.ts";
import { claimTask, getAttemptCount, raiseAttemptCount, updateCurrentTaskRun } from "../shared/taskRunState.ts";
import { writeCheckpoint } from "../shared/checkpoint.ts";

test("test_resetScope_clearsCounters", () => {
    assert.deepEqual(resetScope, { counters: true });
});

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

test("test_main_raisesTestFixesAndRoutesToImplementTaskWhenDeclaredTestsAreMissing", () => {
    const root = makeClaimedProjectRoot(3);
    const worktree = join(root, "worktree");
    updateCurrentTaskRun(3, "run-1", {
        taskTests: {
            stepId: "RUN_TASK_TESTS", testFiles: [], createdTestFiles: [], deletedTestFiles: [],
            missingTests: true, passed: false, output: "", newFailingTests: [], knownFailingTests: [],
            checkedAt: "2026-01-01T00:00:00+00:00",
        },
    }, root);
    writeCheckpoint(worktree, {
        taskNumber: 3, passId: "pass-0", runId: "run-1", projectRoot: root,
        block: "pipeline-commitImplementationIfNeeded.mmd::ARE_2_TEST_FIXES_DONE_Q", input: "{}",
        state: "running", sourceLockHeld: false, exitType: "", exitNote: "", resumedFrom: null,
    });
    const input = { ...packet(root, 3), worktree };
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, { ...input, box: "ARE_2_TEST_FIXES_DONE_Q", exitType: "", exitNote: "", next: "pipeline-implementTask.mmd::IMPLEMENT_TASK" });
    assert.equal(getAttemptCount(3, "testFixes", root), 1);
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
