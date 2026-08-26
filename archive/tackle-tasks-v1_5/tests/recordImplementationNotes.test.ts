// Behavioral checks for recordImplementationNotes.ts. Run alone: node --test tests/recordImplementationNotes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordImplementationNotes } from "../scripts/tackle-tasks/recordImplementationNotes.ts";
import { claimTask, readTaskRunState } from "../scripts/tackle-tasks/taskRunState.ts";

function makeProjectRootWithTasks(tasks: unknown[]): string {
    const root = mkdtempSync(join(tmpdir(), "recordImplementationNotes-"));
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
    return root;
}

test("test_recordImplementationNotes_rejectsAPathThatIsNotInTheWorktree", () => {
    // Setup: an active claimed run, and a worktree directory.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    const worktreePath = mkdtempSync(join(tmpdir(), "recordImplementationNotes-wt-"));

    // Test action + verification: a path outside the worktree is rejected, and nothing is recorded.
    assert.throws(() => recordImplementationNotes(1, worktreePath, "../outside.md", "run-a", root));
    const state = readTaskRunState(1, root);
    assert.equal(state.history[state.history.length - 1].implementationNotesFile, null);
});

test("test_recordImplementationNotes_rejectsAPathThatDoesNotExistOnDisk", () => {
    // Setup: an active claimed run and a real worktree, but no notes file has been written yet.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    const worktreePath = mkdtempSync(join(tmpdir(), "recordImplementationNotes-wt-"));

    // Test action + verification.
    assert.throws(() => recordImplementationNotes(1, worktreePath, "plans/implementation-notes-1.md", "run-a", root));
});

test("test_recordImplementationNotes_rejectsAPathThatEscapesTheWorktreeThroughASymlink", () => {
    // Setup: a symlink inside the worktree points at a file entirely outside it.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    const worktreePath = mkdtempSync(join(tmpdir(), "recordImplementationNotes-wt-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "recordImplementationNotes-outside-"));
    const outsideFile = join(outsideDir, "real-notes.md");
    writeFileSync(outsideFile, "notes\n");
    const symlinkPath = join(worktreePath, "notes-link.md");
    symlinkSync(outsideFile, symlinkPath);

    // Test action + verification: rejected, and nothing is recorded.
    assert.throws(() => recordImplementationNotes(1, worktreePath, "notes-link.md", "run-a", root));
    const state = readTaskRunState(1, root);
    assert.equal(state.history[state.history.length - 1].implementationNotesFile, null);
});

test("test_recordImplementationNotes_recordsAPathThatExistsInsideTheWorktree", () => {
    // Setup: an active claimed run and a real notes file inside the worktree.
    const root = makeProjectRootWithTasks([{ taskNumber: 1, title: "t" }]);
    claimTask(1, "run-a", root);
    const worktreePath = mkdtempSync(join(tmpdir(), "recordImplementationNotes-wt-"));
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    writeFileSync(join(worktreePath, "plans", "implementation-notes-1.md"), "notes\n");

    // Test action: record it.
    const result = recordImplementationNotes(1, worktreePath, "plans/implementation-notes-1.md", "run-a", root);

    // Verification: recorded both in the return value and on the active run.
    assert.deepEqual(result, { implementationNotesFile: "plans/implementation-notes-1.md" });
    const state = readTaskRunState(1, root);
    assert.equal(state.history[state.history.length - 1].implementationNotesFile, "plans/implementation-notes-1.md");
});
