// Behavioral checks for DO_TASK_TESTS_PASS_Q.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./DO_TASK_TESTS_PASS_Q.ts";
import { claimTask, updateCurrentTaskRun } from "../shared/taskRunState.ts";

const TASK_TESTS_RESULT = { stepId: "RUN_TASK_TESTS", testFiles: [], createdTestFiles: [], deletedTestFiles: [], missingTests: false, output: "", newFailingTests: [], knownFailingTests: [], checkedAt: "2026-01-01T00:00:00+00:00" };

function makeClaimedProjectRoot(taskNumber: number, passed: boolean, difficulty: number): string {
    const root = mkdtempSync(join(tmpdir(), "do-task-tests-pass-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "t", difficulty }]));
    const outcome = claimTask(taskNumber, "run-1", root);
    assert.equal(outcome.status, "claimed");
    updateCurrentTaskRun(taskNumber, "run-1", { taskTests: { ...TASK_TESTS_RESULT, passed } }, root);
    return root;
}

function packet(projectRoot: string, taskNumber: number) {
    return { box: "RUN_TASK_TESTS", scriptSignal: "continue", taskNumber, runId: "run-1", projectRoot, worktree: "/abs/worktree", branch: "task-1", exitType: "", exitNote: "" };
}

test("test_main_choosesCodexReviewsTestsWhenPassed", () => {
    const root = makeClaimedProjectRoot(1, true, 5);
    const input = packet(root, 1);
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, { ...input, box: "DO_TASK_TESTS_PASS_Q", next: "pipeline-codexReviewsTests.mmd::CODEX_REVIEWS_TESTS" });
});

test("test_main_choosesAre2TestFixesDoneWhenRed", () => {
    const root = makeClaimedProjectRoot(2, false, 5);
    const input = packet(root, 2);
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, { ...input, box: "DO_TASK_TESTS_PASS_Q", next: "ARE_2_TEST_FIXES_DONE_Q" });
});

test("test_main_throwsWhenNoTaskTestRunIsRecorded", () => {
    const root = mkdtempSync(join(tmpdir(), "do-task-tests-pass-none-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: 3, title: "t" }]));
    assert.equal(claimTask(3, "run-1", root).status, "claimed");
    const input = packet(root, 3);
    assert.throws(() => main(JSON.stringify(input)), /no recorded task-test run/);
});

test("test_main_choosesLockSourceRepoWhenPassedAndDifficultyIsAtMost3", () => {
    // Scenario: a task with difficulty 3 skips the codex test review.
    // Steps: tasks.json holds difficulty 3; the task tests passed; the next block is LOCK_SOURCE_REPO.
    const root = makeClaimedProjectRoot(4, true, 3);
    const input = packet(root, 4);
    const output = main(JSON.stringify(input));
    assert.deepEqual(output, { ...input, box: "DO_TASK_TESTS_PASS_Q", next: "pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO" });
});
