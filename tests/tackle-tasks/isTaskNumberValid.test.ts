// isTaskNumberValid.ts is "is task number valid?" in pipeline.mmd.
// Run alone: node --test tests/tackle-tasks/isTaskNumberValid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTaskNumberValid } from "../../scripts/tackle-tasks/isTaskNumberValid.ts";

function makeProjectRoot(openTasks: unknown[], completedTasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "isTaskNumberValid-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(root, "completedTasks.json"), JSON.stringify(completedTasks));
    return root;
}

test("test_isTaskNumberValid_reportsValidWhenInTasksJson", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }], []);
    assert.deepEqual(isTaskNumberValid(1, root), { valid: true, reason: null });
});

test("test_isTaskNumberValid_reportsInvalidWhenOnlyInCompletedTasksJson", () => {
    // Completed work is not a task this skill can run, so being archived does not make it valid.
    const root = makeProjectRoot([], [{ taskNumber: 2 }]);
    assert.deepEqual(isTaskNumberValid(2, root), { valid: false, reason: "not found in `tasks.json`" });
});

test("test_isTaskNumberValid_reasonNamesTheTaskStoreThatWasActuallySearched", () => {
    // The store is not always at the project root, so the reason must name the resolved file.
    const root = makeProjectRoot([{ taskNumber: 1 }], []);
    assert.deepEqual(isTaskNumberValid(999, root), { valid: false, reason: "not found in `tasks.json`" });
});

test("test_isTaskNumberValid_rejectsRelativeProjectRoot", () => {
    assert.throws(() => isTaskNumberValid(1, "relative/path"), /projectRoot must be an absolute path/);
});

test("test_isTaskNumberValid_cliWorksWhenLaunchedFromAnUnrelatedWorkingDirectory", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }], []);
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "isTaskNumberValid-cwd-"));
    const stdout = execFileSync(
        "node",
        [join(import.meta.dirname, "../../scripts/tackle-tasks/isTaskNumberValid.ts")],
        { input: JSON.stringify({ taskNumber: 1, projectRoot: root }), cwd: unrelatedCwd, encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(stdout), { valid: true, reason: null });
});
