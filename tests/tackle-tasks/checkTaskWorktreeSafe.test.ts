// Behavioral checks for checkTaskWorktreeSafe.ts. Run alone: node --test tests/tackle-tasks/checkTaskWorktreeSafe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTaskWorktreeSafe } from "../../scripts/tackle-tasks/checkTaskWorktreeSafe.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";
import type { TaskGroup } from "../../scripts/taskGroups.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "checkTaskWorktreeSafe-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

test("test_checkTaskWorktreeSafe_reportsUnsafeWhenHeadIsOnTheWrongBranch", () => {
    // Setup: a real linked worktree created for task 1, then switched onto a different branch.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    git(worktreePath, "checkout", "-b", "some-other-branch");

    // Test action: check safety.
    const result = checkTaskWorktreeSafe(1, worktreePath);

    // Verification: unsafe, and the problem names the wrong branch.
    assert.equal(result.safe, false);
    assert.ok(result.problems.some((problem) => problem.includes("some-other-branch")));
});

test("test_checkTaskWorktreeSafe_reportsSafeWhenTheWorktreeHasUncommittedChanges", () => {
    // Setup: a real linked worktree on its correct task branch, with dirty uncommitted edits.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    writeFileSync(join(worktreePath, "seed.txt"), "dirty edit\n");

    // Test action: check safety.
    const result = checkTaskWorktreeSafe(1, worktreePath);

    // Verification: dirty alone is never unsafe (rule 6 — the tree is committed where it matters).
    assert.deepEqual(result, { safe: true, problems: [] });
});

test("test_checkTaskWorktreeSafe_reportsUnsafeWhenThePathDoesNotOpenAsAGitWorktree", () => {
    // Setup: a path that is not a git worktree at all.
    const notAWorktree = mkdtempSync(join(tmpdir(), "checkTaskWorktreeSafe-not-git-"));

    // Test action + verification.
    const result = checkTaskWorktreeSafe(1, notAWorktree);
    assert.equal(result.safe, false);
    assert.equal(result.problems.length, 1);
});
