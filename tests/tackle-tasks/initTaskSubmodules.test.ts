// Behavioral checks for initTaskSubmodules.ts. Run alone: node --test tests/tackle-tasks/initTaskSubmodules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTaskSubmodules } from "../../scripts/tackle-tasks/initTaskSubmodules.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";
import type { TaskGroup } from "../../scripts/taskGroups.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithLocalSubmodule(): string {
    const submoduleOrigin = mkdtempSync(join(tmpdir(), "initTaskSubmodules-sub-"));
    git(submoduleOrigin, "init", "-q");
    git(submoduleOrigin, "config", "user.email", "test@example.com");
    git(submoduleOrigin, "config", "user.name", "Test");
    writeFileSync(join(submoduleOrigin, "seed.txt"), "seed\n");
    git(submoduleOrigin, "add", "seed.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "seed");

    const repoRoot = mkdtempSync(join(tmpdir(), "initTaskSubmodules-"));
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

test("test_initTaskSubmodules_isANoOpAfterCreateTaskWorktree", () => {
    // Setup: createWorktreeForGroup already populates submodules as documented.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);

    // Test action: init submodules again.
    const result = initTaskSubmodules(worktreePath);

    // Verification: the second run is a no-op.
    assert.deepEqual(result, { initialized: false });
});

test("test_initTaskSubmodules_reportsInitializedTrueWhenASubmoduleWasUninitialized", () => {
    // Setup: a real worktree whose submodule directory has been deinitialized.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    git(worktreePath, "submodule", "deinit", "-f", "vendor");

    // Test action: init submodules.
    const result = initTaskSubmodules(worktreePath);

    // Verification: it reports the work it actually did, and the submodule is populated again.
    assert.deepEqual(result, { initialized: true });
    const status = git(worktreePath, "submodule", "status");
    assert.ok(!status.trim().startsWith("-"));
});

test("test_initTaskSubmodules_isANoOpWhenThereIsNoGitmodulesFile", () => {
    // Setup: a plain repo with no submodules at all.
    const repoRoot = mkdtempSync(join(tmpdir(), "initTaskSubmodules-plain-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");

    // Test action + verification.
    assert.deepEqual(initTaskSubmodules(repoRoot), { initialized: false });
});
