// Behavioral checks for ARE_TASK_TESTS_SKIPPED_Q.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./ARE_TASK_TESTS_SKIPPED_Q.ts";

// A throwaway project holding one tasks.json entry, so the decision reads a real entry.
function packetForTask(entry: Record<string, unknown>) {
    const projectRoot = mkdtempSync(join(tmpdir(), "are-task-tests-skipped-"));
    mkdirSync(join(projectRoot, ".taskTools"));
    writeFileSync(join(projectRoot, ".taskTools", "tasks.json"), JSON.stringify([entry]));
    return { taskNumber: 1, runId: "run-1", projectRoot, worktree: "/abs/worktree", branch: "task-1", exitType: "", exitNote: "" };
}

function nextFor(entry: Record<string, unknown>): unknown {
    const packet = packetForTask(entry);
    const output = main(JSON.stringify({ box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: "continue", ...packet }));
    assert.deepEqual(output, { box: "ARE_TASK_TESTS_SKIPPED_Q", scriptSignal: "continue", ...packet, next: output.next });
    return output.next;
}

test("test_main_readsHasTestsOnA101Entry", () => {
    assert.equal(nextFor({ taskNumber: 1, schemaVersion: "1.0.1", hasTests: false }), "pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO");
    assert.equal(nextFor({ taskNumber: 1, schemaVersion: "1.0.1", hasTests: true }), "RUN_TASK_TESTS");
});

test("test_main_readsTestsOnA100Entry", () => {
    assert.equal(nextFor({ taskNumber: 1, schemaVersion: "1.0.0", tests: "skip" }), "pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO");
    assert.equal(nextFor({ taskNumber: 1, schemaVersion: "1.0.0", tests: "add a test for the widget" }), "RUN_TASK_TESTS");
});

// An entry made before schemaVersion existed is a 1.0.0 entry.
test("test_main_treatsAnEntryWithoutSchemaVersionAs100", () => {
    assert.equal(nextFor({ taskNumber: 1, tests: "skip" }), "pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO");
    assert.equal(nextFor({ taskNumber: 1 }), "pipeline-lockSourceRepo.mmd::LOCK_SOURCE_REPO");
});

test("test_main_throwsOnAnUnknownSchemaVersion", () => {
    assert.throws(() => nextFor({ taskNumber: 1, schemaVersion: "2.0.0", hasTests: true }), /unknown schemaVersion "2.0.0"/);
});

test("test_main_throwsWhenTheTaskIsNotFound", () => {
    const packet = packetForTask({ taskNumber: 2 });
    assert.throws(
        () => main(JSON.stringify({ box: "COMMIT_IMPLEMENTATION_IF_NEEDED", scriptSignal: "continue", ...packet })),
        /task 1 not found/,
    );
});
