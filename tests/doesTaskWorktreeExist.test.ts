// Behavioral checks for doesTaskWorktreeExist.ts. Run alone: node --test tests/doesTaskWorktreeExist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doesTaskWorktreeExist } from "../scripts/tackle-tasks/doesTaskWorktreeExist.ts";
import { resolveTaskWorktreeConventionDirectory } from "../scripts/prepareTasks.ts";

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "doesTaskWorktreeExist-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

function conventionalWorktree(root: string, taskNumber: number): string {
    return join(resolveTaskWorktreeConventionDirectory(root), `task-${taskNumber}`);
}

test("test_doesTaskWorktreeExist_reportsTrueWhenTheConventionalPathIsOnDisk", () => {
    // Setup: the conventional worktree directory for task 1 exists.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    const worktreePath = conventionalWorktree(root, 1);
    mkdirSync(worktreePath, { recursive: true });

    // Test action + verification: the box reports the derived worktree as existing.
    assert.deepEqual(doesTaskWorktreeExist(1, root), { exists: true, worktree: worktreePath });
});

test("test_doesTaskWorktreeExist_reportsFalseWhenTheConventionalPathIsAbsent", () => {
    // Setup: a task whose conventional worktree directory was never created.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);

    // Test action + verification.
    assert.deepEqual(doesTaskWorktreeExist(1, root), { exists: false, worktree: null });
});

test("test_doesTaskWorktreeExist_findsARetainedWorktreeAfterTheRunStateForgotIt", () => {
    // Setup: a run ended with its worktree retained, so run.worktree is null while the
    // directory survives on disk. Trusting run.worktree here sent the preamble down the
    // create path and it crashed on the existing worktree.
    const root = makeProjectRootWithTasks([{
        taskNumber: 1, title: "t",
        run: { active: false, worktree: null, leaseRunId: null, history: [] },
    }]);
    const worktreePath = conventionalWorktree(root, 1);
    mkdirSync(worktreePath, { recursive: true });

    // Test action + verification: the retained worktree is found despite the null pointer.
    assert.deepEqual(doesTaskWorktreeExist(1, root), { exists: true, worktree: worktreePath });
});
