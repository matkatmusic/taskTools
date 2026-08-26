// Behavioral checks for scripts/steps/pipeline-taskTests/ARE_2_TEST_FIXES_DONE.ts.
// Run: node --test tests/steps/pipeline-taskTests/ARE_2_TEST_FIXES_DONE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-taskTests/ARE_2_TEST_FIXES_DONE.ts";
import { claimTask, raiseAttemptCount } from "../../../scripts/tackle-tasks/taskRunState.ts";

function makeClaimedProjectRoot(taskNumber: number, runId: string): string {
    const root = mkdtempSync(join(tmpdir(), "are-2-test-fixes-done-"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "t" }]));
    const outcome = claimTask(taskNumber, runId, root);
    assert.equal(outcome.status, "claimed");
    return root;
}

function packetFor(root: string): { taskNumber: number; runId: string; worktreePath: string; sourceBranch: string; projectRoot: string } {
    return { taskNumber: 1, runId: "run-1", worktreePath: "/abs/worktree", sourceBranch: "main", projectRoot: root };
}

test("test_ARE_2_TEST_FIXES_DONE_continuesToAmendWhenNoFixHasBeenAttempted", () => {
    const root = makeClaimedProjectRoot(1, "run-1");
    const packet = packetFor(root);
    const output = main(JSON.stringify({ box: "DO_TASK_TESTS_PASS", scriptSignal: "continue", ...packet, next: "ARE_2_TEST_FIXES_DONE" }));
    assert.deepEqual(output, { box: "ARE_2_TEST_FIXES_DONE", scriptSignal: "continue", ...packet, exitType: "", exitNote: "", next: "AMEND_ENTRY_WITH_FAILING_TESTS" });
});

test("test_ARE_2_TEST_FIXES_DONE_exitsTestsRedAfter2Attempts", () => {
    const root = makeClaimedProjectRoot(1, "run-1");
    raiseAttemptCount(1, "run-1", "testFixes", root);
    raiseAttemptCount(1, "run-1", "testFixes", root);
    const packet = packetFor(root);
    const output = main(JSON.stringify({ box: "DO_TASK_TESTS_PASS", scriptSignal: "continue", ...packet, next: "ARE_2_TEST_FIXES_DONE" }));
    assert.deepEqual(output, {
        box: "ARE_2_TEST_FIXES_DONE", scriptSignal: "continue", ...packet,
        exitType: "tests-red", exitNote: "task tests still failing after 2 fix attempts", next: "EXIT_WORKFLOW_TASK_TESTS",
    });
});
