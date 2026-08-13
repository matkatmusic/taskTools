// isTaskOpen.ts is "is task open?" in pipeline.mmd.
// Run alone: node --test tests/tackle-tasks/isTaskOpen.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTaskOpen } from "../../scripts/tackle-tasks/isTaskOpen.ts";

function makeProjectRoot(openTasks: unknown[], completedTasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "isTaskOpen-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify(openTasks));
    writeFileSync(join(root, "completedTasks.json"), JSON.stringify(completedTasks));
    return root;
}

test("test_isTaskOpen_reportsOpenWhenOnlyInTasksJson", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }], []);
    assert.deepEqual(isTaskOpen(1, root), { open: true, closeInProgress: false });
});

test("test_isTaskOpen_reportsNotOpenWhenOnlyInCompletedTasksJson", () => {
    const root = makeProjectRoot([], [{ taskNumber: 2 }]);
    assert.deepEqual(isTaskOpen(2, root), { open: false, closeInProgress: false });
});

test("test_isTaskOpen_reportsCloseInProgressWhenTheTaskIsInBothFiles", () => {
    const root = makeProjectRoot([{ taskNumber: 3 }], [{ taskNumber: 3 }]);
    assert.deepEqual(isTaskOpen(3, root), { open: false, closeInProgress: true });
});

test("test_isTaskOpen_reportsNotOpenWhenInNeitherFile", () => {
    const root = makeProjectRoot([{ taskNumber: 1 }], []);
    assert.deepEqual(isTaskOpen(999, root), { open: false, closeInProgress: false });
});
