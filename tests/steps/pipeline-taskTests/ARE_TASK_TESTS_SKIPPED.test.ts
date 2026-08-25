// Behavioral checks for scripts/steps/pipeline-taskTests/ARE_TASK_TESTS_SKIPPED.ts.
// Run: node --test tests/steps/pipeline-taskTests/ARE_TASK_TESTS_SKIPPED.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../../scripts/steps/pipeline-taskTests/ARE_TASK_TESTS_SKIPPED.ts";

// A throwaway project holding one tasks.json entry, so the decision reads a real entry.
function packetForTask(entry: Record<string, unknown>) {
    const projectRoot = mkdtempSync(join(tmpdir(), "are-task-tests-skipped-"));
    mkdirSync(join(projectRoot, ".taskTools"));
    writeFileSync(join(projectRoot, ".taskTools", "tasks.json"), JSON.stringify([entry]));
    return { taskNumber: 1, runId: "run-1", worktreePath: "/abs/worktree", sourceBranch: "main", projectRoot };
}

function nextFor(entry: Record<string, unknown>): unknown {
    const packet = packetForTask(entry);
    const output = main(JSON.stringify({ box: "COMMITTED_WORK_INPUT", scriptSignal: "continue", ...packet }));
    assert.deepEqual(output, { box: "ARE_TASK_TESTS_SKIPPED", scriptSignal: "continue", ...packet, next: output.next });
    return output.next;
}

test("test_ARE_TASK_TESTS_SKIPPED_readsHasTestsOnA101Entry", () => {
    assert.equal(nextFor({ taskNumber: 1, schemaVersion: "1.0.1", hasTests: false }), "REBASE_PREAMBLE_PIPELINE");
    assert.equal(nextFor({ taskNumber: 1, schemaVersion: "1.0.1", hasTests: true }), "RUN_TASK_TESTS");
});

test("test_ARE_TASK_TESTS_SKIPPED_readsTestsOnA100Entry", () => {
    assert.equal(nextFor({ taskNumber: 1, schemaVersion: "1.0.0", tests: "skip" }), "REBASE_PREAMBLE_PIPELINE");
    assert.equal(nextFor({ taskNumber: 1, schemaVersion: "1.0.0", tests: "add a test for the widget" }), "RUN_TASK_TESTS");
});

// An entry made before schemaVersion existed is a 1.0.0 entry.
test("test_ARE_TASK_TESTS_SKIPPED_treatsAnEntryWithoutSchemaVersionAs100", () => {
    assert.equal(nextFor({ taskNumber: 1, tests: "skip" }), "REBASE_PREAMBLE_PIPELINE");
    assert.equal(nextFor({ taskNumber: 1 }), "REBASE_PREAMBLE_PIPELINE");
});

test("test_ARE_TASK_TESTS_SKIPPED_throwsOnAnUnknownSchemaVersion", () => {
    assert.throws(() => nextFor({ taskNumber: 1, schemaVersion: "2.0.0", hasTests: true }), /unknown schemaVersion "2.0.0"/);
});
