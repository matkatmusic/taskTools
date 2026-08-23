// Behavioral checks for initTaskSubmodules.ts. Run alone: node --test tests/initTaskSubmodules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTaskSubmodules } from "../scripts/tackle-tasks/initTaskSubmodules.ts";
import { createWorktreeForGroup } from "../scripts/prepareTasks.ts";
import type { TaskGroup } from "../scripts/taskGroups.ts";
import { claimTask } from "../scripts/tackle-tasks/taskRunState.ts";
import { resolveTaskFiles } from "../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../scripts/taskStateLock.ts";

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

let nextTaskNumber = 1;
function seedTaskAndClaim(projectRoot: string, runId: string): number {
    const taskNumber = nextTaskNumber++;
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
    return taskNumber;
}

function runInit(worktreePath: string, projectRoot: string) {
    const runId = `run-${nextTaskNumber}`;
    const taskNumber = seedTaskAndClaim(projectRoot, runId);
    return initTaskSubmodules({ worktreePath, taskNumber, runId, projectRoot, stepId: `step-${taskNumber}` });
}

test("test_initTaskSubmodules_isANoOpAfterCreateTaskWorktree", () => {
    // Setup: createWorktreeForGroup already populates submodules as documented.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "declared" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);

    // Test action: init submodules again.
    const result = runInit(worktreePath, repoRoot);

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
    const result = runInit(worktreePath, repoRoot);

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
    assert.deepEqual(runInit(repoRoot, repoRoot), { initialized: false });
});

test("test_initTaskSubmodules_neverReturnsANonBooleanInitializationStateForAnyReachableInput", () => {
    // The real script always checks submodule status before initializing, so it can always tell
    // whether it did work - the returned field is a plain boolean, never a tri-state guess.
    const noGitmodulesRoot = mkdtempSync(join(tmpdir(), "initTaskSubmodules-plain2-"));
    git(noGitmodulesRoot, "init", "-q");
    git(noGitmodulesRoot, "config", "user.email", "test@example.com");
    git(noGitmodulesRoot, "config", "user.name", "Test");
    writeFileSync(join(noGitmodulesRoot, "seed.txt"), "seed\n");
    git(noGitmodulesRoot, "add", "seed.txt");
    git(noGitmodulesRoot, "commit", "-q", "-m", "seed");

    const repoRoot = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "declared" };
    const alreadyPopulatedWorktree = createWorktreeForGroup(repoRoot, group);
    const deinitializedWorktree = createWorktreeForGroup(
        repoRoot, { groupId: 2, taskNumbers: [2], filePaths: [], scope: "declared" },
    );
    git(deinitializedWorktree, "submodule", "deinit", "-f", "vendor");

    for (const worktreePath of [noGitmodulesRoot, alreadyPopulatedWorktree, deinitializedWorktree]) {
        assert.equal(typeof runInit(worktreePath, repoRoot).initialized, "boolean");
    }
});
