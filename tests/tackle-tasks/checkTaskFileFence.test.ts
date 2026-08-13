// Behavioral checks for scripts/tackle-tasks/checkTaskFileFence.ts. Run: node --test tests/tackle-tasks/checkTaskFileFence.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTaskFileFence } from "../../scripts/tackle-tasks/checkTaskFileFence.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../scripts/taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = tmpMkdir("check-fence-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

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

function seedTask(rootOrigin: string, taskNumber: number, files: string[]): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files }]);
}

test("test_checkTaskFileFence_acceptsAnOwnedPathInsideASubmodule", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 20;
    seedTask(rootOrigin, taskNumber, ["child/widget.txt"]);

    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    git(join(worktreePath, "child"), "add", "widget.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "add widget");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    const result = checkTaskFileFence({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-20", rootSourceBranch: "main",
    });

    assert.equal(result.inside, true);
    assert.deepEqual(result.violations, []);
});

test("test_checkTaskFileFence_reportsAViolationForAPathTheAgentDidNotDeclare", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 21;
    seedTask(rootOrigin, taskNumber, ["child/widget.txt"]);

    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    git(join(worktreePath, "child"), "add", "widget.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "add widget");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    // Undeclared edit at root, outside the task's owned files.
    writeFileSync(join(worktreePath, "sneaky.txt"), "not owned\n");
    git(worktreePath, "add", "sneaky.txt");
    git(worktreePath, "commit", "-q", "-m", "sneaky root edit");

    const result = checkTaskFileFence({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-21", rootSourceBranch: "main",
    });

    assert.equal(result.inside, false);
    assert.deepEqual(result.violations, ["sneaky.txt"]);
});
