// Behavioral checks for the worktree-path collision fix in prepareTasks.ts. Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
    createWorktreeForGroup,
    renderTaskBriefContent,
    resolveTaskWorktreeConventionDirectory,
    writeTaskBriefFile,
} from "../../scripts/prepareTasks.ts";
import type { TaskGroup } from "../../scripts/taskGroups.ts";
import type { TaskRecord } from "../../scripts/taskFiles.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommitAt(parentDir: string, repoName: string): string {
    const repoRoot = join(parentDir, repoName);
    mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

test("test_createWorktreeForGroup_doesNotCollideBetweenTwoReposWithTheSameBasename", () => {
    // Setup: two different repos, both named "repo", living under different temp parents.
    const parentA = mkdtempSync(join(tmpdir(), "prepare-tasks-collide-a-"));
    const parentB = mkdtempSync(join(tmpdir(), "prepare-tasks-collide-b-"));
    const repoA = makeTempRepoWithCommitAt(parentA, "repo");
    const repoB = makeTempRepoWithCommitAt(parentB, "repo");
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };

    // Test action: prepare a worktree for the same group id in each repo.
    const worktreeA = createWorktreeForGroup(repoA, group, "run-a");
    const worktreeB = createWorktreeForGroup(repoB, group, "run-b");

    // Verification: the two "repo" basenames land in different convention directories.
    assert.notEqual(worktreeA, worktreeB);
    assert.notEqual(dirname(worktreeA), dirname(worktreeB));
});

test("test_resolveTaskWorktreeConventionDirectory_isStableAcrossCalls", () => {
    // Setup: one repo path.
    const parent = mkdtempSync(join(tmpdir(), "prepare-tasks-stable-"));
    const repoRoot = makeTempRepoWithCommitAt(parent, "repo");

    // Test action: resolve the convention directory twice for the same input.
    const first = resolveTaskWorktreeConventionDirectory(repoRoot);
    const second = resolveTaskWorktreeConventionDirectory(repoRoot);

    // Verification: same input, same output, both times.
    assert.equal(first, second);
    assert.equal(basename(dirname(first)), "taskTools-wt");
});

test("test_renderTaskBriefContent_matchesWhatWriteTaskBriefFileWrites", () => {
    // Setup: a repo root and a task record with a declared file.
    const parent = mkdtempSync(join(tmpdir(), "prepare-tasks-brief-"));
    const repoRoot = makeTempRepoWithCommitAt(parent, "repo");
    const task: TaskRecord = {
        taskNumber: 999,
        title: "example task",
        description: "example description",
        files: ["seed.txt"],
    } as TaskRecord;

    // Test action: render the brief content purely, then write the brief file for real.
    const rendered = renderTaskBriefContent(task, repoRoot);
    const briefFile = writeTaskBriefFile(task, repoRoot);
    const written = readFileSync(briefFile, "utf8");

    // Verification: the pure renderer's bytes exactly match what got written to disk.
    assert.equal(rendered, written);
});
