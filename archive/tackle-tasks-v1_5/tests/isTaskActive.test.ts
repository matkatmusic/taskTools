// isTaskActive.ts is "is the task active?" in pipeline-preamble.mmd.
// Run alone: node --test tests/isTaskActive.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTaskActive } from "../scripts/tackle-tasks/isTaskActive.ts";
import { readTaskRunState } from "../scripts/tackle-tasks/taskRunState.ts";

function makeProjectRoot(openTasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "isTaskActive-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
    return root;
}

test("test_isTaskActive_claimsAnUnclaimedTaskAndActivatesItInTasksJson", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    const output = isTaskActive(1, "run-a", root);
    assert.deepEqual(output, { status: "claimed", heldByRunId: null, reason: null });
    assert.equal(readTaskRunState(1, root).active, true);
});

test("test_isTaskActive_refusesATaskAlreadyClaimedByAnotherRun", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    isTaskActive(1, "run-a", root);
    const output = isTaskActive(1, "run-b", root);
    assert.deepEqual(output, { status: "refused", heldByRunId: "run-a", reason: "is already active in run run-a" });
});

test("test_isTaskActive_reportsNotFoundForATaskAbsentFromTasksJson", () => {
    const root = makeProjectRoot([]);
    const output = isTaskActive(999, "run-a", root);
    assert.deepEqual(output, { status: "not-found", heldByRunId: null, reason: "not found in `.taskTools/tasks.json`" });
});

test("test_isTaskActive_rejectsRelativeProjectRoot", () => {
    assert.throws(() => isTaskActive(1, "run-a", "relative/path"), /projectRoot must be an absolute path/);
});

test("test_isTaskActive_cliWorksWhenLaunchedFromAnUnrelatedWorkingDirectory", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    const unrelatedCwd = mkdtempSync(join(tmpdir(), "isTaskActive-cwd-"));
    const stdout = execFileSync(
        "node",
        [join(import.meta.dirname, "../scripts/tackle-tasks/isTaskActive.ts")],
        { input: JSON.stringify({ taskNumber: 1, runId: "run-a", projectRoot: root }), cwd: unrelatedCwd, encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(stdout), { status: "claimed", heldByRunId: null, reason: null });
});
