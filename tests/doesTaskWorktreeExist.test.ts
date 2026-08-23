// Behavioral checks for doesTaskWorktreeExist.ts. Run alone: node --test tests/tackle-tasks/doesTaskWorktreeExist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doesTaskWorktreeExist } from "../../scripts/tackle-tasks/doesTaskWorktreeExist.ts";

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "doesTaskWorktreeExist-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

test("test_doesTaskWorktreeExist_reportsTrueWhenTheRecordedPathIsOnDisk", () => {
    // Setup: a task whose run state records a worktree path that really exists on disk.
    const root = makeProjectRootWithTasks([]);
    const worktreePath = mkdtempSync(join(tmpdir(), "doesTaskWorktreeExist-wt-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: worktreePath, leaseRunId: "run-a", history: [] },
    }]));

    // Test action + verification: the box reports the recorded worktree as existing.
    assert.deepEqual(doesTaskWorktreeExist(1, root), { exists: true, worktree: worktreePath });
});

test("test_doesTaskWorktreeExist_reportsFalseWhenTheRecordedPathHasBeenRemoved", () => {
    // Setup: the run state names a worktree path that has since been deleted.
    const root = makeProjectRootWithTasks([]);
    const removedPath = join(tmpdir(), "does-not-exist-doesTaskWorktreeExist-a1b2c3");
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{
        taskNumber: 1, title: "t",
        run: { active: true, worktree: removedPath, leaseRunId: "run-a", history: [] },
    }]));

    // Test action + verification: a recorded path that is gone means exists:false.
    assert.deepEqual(doesTaskWorktreeExist(1, root), { exists: false, worktree: null });
});

test("test_doesTaskWorktreeExist_reportsFalseWhenNoWorktreeHasEverBeenRecorded", () => {
    // Setup: a task that has never had a worktree recorded.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);

    // Test action + verification.
    assert.deepEqual(doesTaskWorktreeExist(1, root), { exists: false, worktree: null });
});
