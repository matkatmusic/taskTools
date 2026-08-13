// isTaskBlocked.ts is "is task blocked?" in pipeline.mmd.
// Run alone: node --test tests/tackle-tasks/isTaskBlocked.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTaskBlocked } from "../../scripts/tackle-tasks/isTaskBlocked.ts";

function makeProjectRoot(openTasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "isTaskBlocked-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(root, "completedTasks.json"), JSON.stringify([]));
    return root;
}

test("test_isTaskBlocked_reportsBlockedWhenBlockedByNamesAnOpenTask", () => {
    const root = makeProjectRoot([
        { taskNumber: 1, blockedBy: [{ taskNum: 2, reason: "needs schema" }] },
        { taskNumber: 2 },
    ]);
    assert.deepEqual(isTaskBlocked(1, root), {
        blocked: true,
        blockers: [{ taskNum: 2, reason: "needs schema" }],
    });
});

test("test_isTaskBlocked_reportsNotBlockedWhenBlockerIsNotOpen", () => {
    const root = makeProjectRoot([
        { taskNumber: 1, blockedBy: [{ taskNum: 2, reason: "needs schema" }] },
    ]);
    assert.deepEqual(isTaskBlocked(1, root), { blocked: false, blockers: [] });
});

test("test_isTaskBlocked_reportsNotBlockedWhenNoBlockedByField", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }]);
    assert.deepEqual(isTaskBlocked(1, root), { blocked: false, blockers: [] });
});
