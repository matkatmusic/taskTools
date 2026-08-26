// Behavioral checks for scripts/tackle-tasks/recordTaskModifiedFiles.ts.
// Run: node --test tests/recordTaskModifiedFiles.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordTaskModifiedFiles } from "./recordTaskModifiedFiles.ts";
import { createWorktreeForGroup } from "../../prepareTasks.ts";
import { resolveTaskFiles } from "../../taskFiles.ts";

// git submodule add/clone needs this in a sandboxed test environment.
process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = mkdtempSync(join(tmpdir(), "recordTaskModifiedFiles-"));
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

// The canonical source repository: a root repo with one real submodule, per global rule 9.
function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeTempRepoWithCommit("child-main");
    const rootOrigin = makeTempRepoWithCommit("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return rootOrigin;
}

let nextGroupId = 1;

function createLinkedWorktree(rootOrigin: string): string {
    const groupId = nextGroupId++;
    return createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
}

function writeTasksJson(projectRoot: string, task: unknown): void {
    writeFileSync(join(projectRoot, "tasks.json"), `${JSON.stringify([task], null, 2)}\n`);
}

function readTasksJson(projectRoot: string): any[] {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    return JSON.parse(readFileSync(tasksPath, "utf8"));
}

function activeRun() {
    return {
        active: true, worktree: null, leaseRunId: null,
        history: [{
            runId: "run-a", startedAt: "2026-08-01T00:00:00-07:00", endedAt: null,
            exitType: null, exitNote: null, modifiedFiles: [] as string[], commits: [],
            implementationNotesFile: null, taskTests: null, fullSuite: null,
        }],
    };
}

test("test_recordTaskModifiedFiles_doesNotChangeTheTasksOwnedFilesList", () => {
    // Setup: a task with a declared ownership fence, and an active run.
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    writeFileSync(join(worktreePath, "changed.txt"), "change\n");
    git(worktreePath, "add", "changed.txt");
    git(worktreePath, "commit", "-q", "-m", "work");
    writeTasksJson(rootOrigin, { taskNumber: 1, title: "t", files: ["changed.txt"], run: activeRun() });

    // Test action: record modified files.
    recordTaskModifiedFiles({ taskNumber: 1, runId: "run-a", projectRoot: rootOrigin, worktree: worktreePath, sourceBranch: "main" });

    // Verification: task.files, the ownership fence, is untouched.
    const tasks = readTasksJson(rootOrigin);
    assert.deepEqual(tasks[0].files, ["changed.txt"]);
});

test("test_recordTaskModifiedFiles_includesPathsChangedInsideASubmodule", () => {
    // Setup: a source repo with a submodule, checked out into a real linked worktree, with a
    // change committed inside the submodule.
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    writeFileSync(join(worktreePath, "child", "newfile.txt"), "change\n");
    git(join(worktreePath, "child"), "add", "newfile.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "child change");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    writeTasksJson(rootOrigin, { taskNumber: 1, title: "t", files: [], run: activeRun() });

    // Test action: record modified files.
    const output = recordTaskModifiedFiles({
        taskNumber: 1, runId: "run-a", projectRoot: rootOrigin, worktree: worktreePath, sourceBranch: "main",
    });

    // Verification: the submodule's changed file is reported, occurrence-prefixed.
    assert.ok(output.modifiedFiles.includes("child::newfile.txt"));
    const tasks = readTasksJson(rootOrigin);
    assert.deepEqual(tasks[0].run.history[0].modifiedFiles, output.modifiedFiles);
});

test("test_recordTaskModifiedFiles_leavesAnExistingRecordAloneWhenTheWorktreeIsGone", () => {
    // Setup: a task whose run already has a real, non-empty modifiedFiles record, but whose
    // worktree has since been deleted (clean-up already ran, or it was never created).
    const rootOrigin = makeSourceRepoWithSubmodule();
    const run = activeRun();
    run.history[0].modifiedFiles = ["scripts/foo.ts"];
    writeTasksJson(rootOrigin, { taskNumber: 1, title: "t", files: [], run });

    // Test action: record modified files with no worktree.
    const output = recordTaskModifiedFiles({
        taskNumber: 1, runId: "run-a", projectRoot: rootOrigin, worktree: null, sourceBranch: "main",
    });

    // Verification: the reported output is empty, but the stored record is untouched.
    assert.deepEqual(output, { modifiedFiles: [] });
    const tasks = readTasksJson(rootOrigin);
    assert.deepEqual(tasks[0].run.history[0].modifiedFiles, ["scripts/foo.ts"]);
});

test("test_recordTaskModifiedFiles_throwsWithASiblingRunId", () => {
    // F6: the active run belongs to run-new; a paused run-old process must not be able to
    // write into it.
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const run = activeRun();
    run.history[0].runId = "run-new";
    writeTasksJson(rootOrigin, { taskNumber: 1, title: "t", files: [], run });

    assert.throws(() => recordTaskModifiedFiles({
        taskNumber: 1, runId: "run-old", projectRoot: rootOrigin, worktree: worktreePath, sourceBranch: "main",
    }));
});
