// Behavioral checks for createTaskWorktree.ts. Run alone: node --test tests/tackle-tasks/createTaskWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskWorktree, taskBranchName } from "../../scripts/tackle-tasks/createTaskWorktree.ts";
import { claimTask, readTaskRunState } from "../../scripts/tackle-tasks/taskRunState.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeProjectRootWithLocalSubmodule(): string {
    const submoduleOrigin = mkdtempSync(join(tmpdir(), "createTaskWorktree-sub-"));
    git(submoduleOrigin, "init", "-q");
    git(submoduleOrigin, "config", "user.email", "test@example.com");
    git(submoduleOrigin, "config", "user.name", "Test");
    writeFileSync(join(submoduleOrigin, "seed.txt"), "seed\n");
    git(submoduleOrigin, "add", "seed.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "seed");

    const root = mkdtempSync(join(tmpdir(), "createTaskWorktree-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    writeFileSync(join(root, "fileA.txt"), "root file\n");
    git(root, "add", "fileA.txt");
    git(root, "commit", "-q", "-m", "seed");
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(root, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(root, "commit", "-q", "-m", "add submodule");
    return root;
}

function seedTasksFile(root: string, tasks: unknown[]): void {
    writeFileSync(join(root, "tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`);
}

test("test_createTaskWorktree_createsARealWorktreeOnTheTasksBranchWithSubmodulesPopulated", () => {
    // Setup: a real repo with a real submodule, and an active claimed run for task 1.
    const root = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: ["fileA.txt"] }]);
    claimTask(1, "run-a", root);

    // Test action: create the task worktree.
    const output = createTaskWorktree(1, "run-a", root);

    // Verification: a real linked worktree exists, checked out on the task's branch, submodule populated.
    assert.equal(output.branch, taskBranchName(1));
    assert.ok(existsSync(output.worktree));
    const currentBranch = git(output.worktree, "branch", "--show-current").trim();
    assert.equal(currentBranch, "task-1");
    assert.ok(existsSync(join(output.worktree, "vendor", "seed.txt")));
});

test("test_createTaskWorktree_recordsTheWorktreePathOnTheActiveRun", () => {
    // Setup: a real repo, an active claimed run.
    const root = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);

    // Test action: create the worktree.
    const output = createTaskWorktree(1, "run-a", root);

    // Verification: the run state's worktree and leaseRunId reflect the new worktree.
    const state = readTaskRunState(1, root);
    assert.equal(state.worktree, output.worktree);
    assert.equal(state.leaseRunId, "run-a");
});
