// Behavioral checks for resetTaskWorktree.ts. Run alone: node --test tests/tackle-tasks/resetTaskWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTaskWorktree } from "../../scripts/tackle-tasks/resetTaskWorktree.ts";
import { claimTask, readTaskRunState } from "../../scripts/tackle-tasks/taskRunState.ts";
import { createTaskWorktree } from "../../scripts/tackle-tasks/createTaskWorktree.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeProjectRootWithLocalSubmodule(): string {
    const submoduleOrigin = mkdtempSync(join(tmpdir(), "resetTaskWorktree-sub-"));
    git(submoduleOrigin, "init", "-q");
    git(submoduleOrigin, "config", "user.email", "test@example.com");
    git(submoduleOrigin, "config", "user.name", "Test");
    writeFileSync(join(submoduleOrigin, "seed.txt"), "seed\n");
    git(submoduleOrigin, "add", "seed.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "seed");

    const root = mkdtempSync(join(tmpdir(), "resetTaskWorktree-"));
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

test("test_resetTaskWorktree_succeedsWhenRunTwice", () => {
    // Setup: a real repo with a real submodule; task 1's worktree is created, dirtied, and leaked
    // by a prior run that never released its lease.
    const root = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-old", root);

    // Test action: reset twice in a row, each time with a fresh runId, as a half-finished
    // reset followed by a retry would.
    const first = resetTaskWorktree(1, "run-old", root);
    writeFileSync(join(first.worktree, "dirty.txt"), "leaked work\n");
    const second = resetTaskWorktree(1, "run-old", root);

    // Verification: the second reset produces a clean, real worktree on the task branch, and
    // the leaked file from the first attempt is gone.
    assert.equal(second.branch, "task-1");
    assert.ok(existsSync(second.worktree));
    assert.ok(!existsSync(join(second.worktree, "dirty.txt")));
    const currentBranch = git(second.worktree, "branch", "--show-current").trim();
    assert.equal(currentBranch, "task-1");
    const state = readTaskRunState(1, root);
    assert.equal(state.worktree, second.worktree);
});

test("test_resetTaskWorktree_refusesAndLeavesEverythingUnchangedWhenTheSiblingLeaseNamesAnotherOwner", () => {
    // Setup: task state names run-a as the worktree's owner, but a sibling run "run-b" holds
    // the actual physical lease (e.g. a racing recovery already reassigned it out-of-band).
    const root = makeProjectRootWithLocalSubmodule();
    seedTasksFile(root, [{ taskNumber: 1, title: "t1", description: "do it", files: [] }]);
    claimTask(1, "run-a", root);
    const created = createTaskWorktree(1, "run-a", root);
    const mergedCommitRef = "refs/taskTools/merged-commits/task-1";
    const mergedCommitOid = git(root, "rev-parse", "HEAD").trim();
    git(root, "update-ref", mergedCommitRef, mergedCommitOid);
    writeFileSync(`${created.worktree}.lease`, JSON.stringify({ runId: "run-b", pid: 1, createdAt: 1 }));

    // Snapshot everything the refusal must leave untouched.
    const worktreeHeadBefore = git(created.worktree, "rev-parse", "HEAD").trim();
    const leaseBefore = readFileSync(`${created.worktree}.lease`, "utf8");
    const tasksJsonBefore = readFileSync(join(root, "tasks.json"), "utf8");
    const mergedRefBefore = git(root, "rev-parse", "--verify", mergedCommitRef).trim();

    // Test action + verification: reset as run-a refuses instead of destroying run-b's worktree.
    assert.throws(() => resetTaskWorktree(1, "run-a", root), /run-b/);

    // Verification: worktree, branch, persistence ref, task state and run-b's lease are all
    // byte-for-byte unchanged.
    assert.ok(existsSync(created.worktree));
    assert.equal(git(created.worktree, "rev-parse", "HEAD").trim(), worktreeHeadBefore);
    assert.equal(git(created.worktree, "branch", "--show-current").trim(), "task-1");
    assert.equal(readFileSync(`${created.worktree}.lease`, "utf8"), leaseBefore);
    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), tasksJsonBefore);
    assert.equal(git(root, "rev-parse", "--verify", mergedCommitRef).trim(), mergedRefBefore);
});
