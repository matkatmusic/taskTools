// Behavioral checks for generateTaskDocs.ts and updateTaskDocs.ts producing identical briefs.
// Run alone: node --test tests/tackle-tasks/generateTaskDocs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTaskDocs } from "../../scripts/tackle-tasks/generateTaskDocs.ts";
import { updateTaskDocs } from "../../scripts/tackle-tasks/updateTaskDocs.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";
import type { TaskGroup } from "../../scripts/taskGroups.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithLocalSubmodule(): string {
    const submoduleOrigin = mkdtempSync(join(tmpdir(), "generateTaskDocs-sub-"));
    git(submoduleOrigin, "init", "-q");
    git(submoduleOrigin, "config", "user.email", "test@example.com");
    git(submoduleOrigin, "config", "user.name", "Test");
    writeFileSync(join(submoduleOrigin, "seed.txt"), "seed\n");
    git(submoduleOrigin, "add", "seed.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "seed");

    const repoRoot = mkdtempSync(join(tmpdir(), "generateTaskDocs-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "fileA.txt"), "seed\n");
    git(repoRoot, "add", "fileA.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(repoRoot, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(repoRoot, "commit", "-q", "-m", "add submodule");
    return repoRoot;
}

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_generateTaskDocs_andUpdateTaskDocs_produceTheSameBrief", () => {
    // Setup: a real linked worktree for task 9.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    seedTasksFile(repoRoot, [{ taskNumber: 9, title: "t9", description: "do it", files: ["fileA.txt"] }]);
    const group: TaskGroup = { groupId: 9, taskNumbers: [9], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);

    // Test action: generate, then update, the docs for the same task and worktree.
    const generated = generateTaskDocs(9, worktreePath, repoRoot);
    const updated = updateTaskDocs(9, worktreePath, repoRoot);

    // Verification: same file path, same bytes.
    assert.equal(generated.briefFile, updated.briefFile);
    assert.equal(readFileSync(generated.briefFile, "utf8"), readFileSync(updated.briefFile, "utf8"));
});

test("test_generateTaskDocs_hidesAnAlreadyTrackedBriefFromGitAddAll", () => {
    // Setup: a linked worktree whose index already tracks a stale generated brief.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    seedTasksFile(repoRoot, [{ taskNumber: 9, title: "t9", description: "do it", files: [] }]);
    mkdirSync(join(repoRoot, "plans"), { recursive: true });
    writeFileSync(join(repoRoot, "plans", "brief-9.md"), "old brief\n");
    git(repoRoot, "add", "plans/brief-9.md");
    git(repoRoot, "commit", "-q", "-m", "add brief-9");
    const group: TaskGroup = { groupId: 9, taskNumbers: [9], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);

    // Test action: generate fresh docs, which rewrite the tracked brief.
    generateTaskDocs(9, worktreePath, repoRoot);

    // Verification: `git add -A` in the worktree does not surface the regenerated brief.
    git(worktreePath, "add", "-A");
    const stagedNames = git(worktreePath, "diff", "--cached", "--name-only");
    assert.ok(!stagedNames.includes("plans/brief-9.md"));
});
