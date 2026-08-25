// Behavioral checks for scripts/steps/pipeline-taskTests/ARE_TASK_TESTS_SKIPPED.ts.
// Run: node --test tests/steps/pipeline-taskTests/ARE_TASK_TESTS_SKIPPED.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-taskTests/ARE_TASK_TESTS_SKIPPED.ts";

// A throwaway project holding one tasks.json entry, so the decision reads a real tests field.
function packetForTask(entry: Record<string, unknown>) {
    const projectRoot = mkdtempSync(join(tmpdir(), "are-task-tests-skipped-"));
    mkdirSync(join(projectRoot, ".taskTools"));
    writeFileSync(join(projectRoot, ".taskTools", "tasks.json"), JSON.stringify([entry]));
    return { taskNumber: 1, runId: "run-1", worktreePath: "/abs/worktree", sourceBranch: "main", projectRoot };
}

test("test_ARE_TASK_TESTS_SKIPPED_choosesRebasePreambleWhenTestsIsSkip", () => {
    const packet = packetForTask({ taskNumber: 1, tests: "skip" });
    const output = main(JSON.stringify({ box: "COMMITTED_WORK_INPUT", scriptSignal: "continue", ...packet }));
    assert.deepEqual(output, { box: "ARE_TASK_TESTS_SKIPPED", scriptSignal: "continue", ...packet, next: "REBASE_PREAMBLE_PIPELINE" });
});

test("test_ARE_TASK_TESTS_SKIPPED_choosesRunTaskTestsForAnyOtherTestsField", () => {
    const packet = packetForTask({ taskNumber: 1, tests: "npm test" });
    const output = main(JSON.stringify({ box: "COMMITTED_WORK_INPUT", scriptSignal: "continue", ...packet }));
    assert.deepEqual(output, { box: "ARE_TASK_TESTS_SKIPPED", scriptSignal: "continue", ...packet, next: "RUN_TASK_TESTS" });
});

test("test_ARE_TASK_TESTS_SKIPPED_choosesRunTaskTestsWhenTheEntryHasNoTestsField", () => {
    const packet = packetForTask({ taskNumber: 1 });
    const output = main(JSON.stringify({ box: "COMMITTED_WORK_INPUT", scriptSignal: "continue", ...packet }));
    assert.equal(output.next, "RUN_TASK_TESTS");
});
