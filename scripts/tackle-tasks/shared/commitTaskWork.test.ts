// Behavioral checks for scripts/tackle-tasks/commitTaskWork.ts. Run: node --test tests/commitTaskWork.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitTaskWork } from "./commitTaskWork.ts";
import { claimTask, getCurrentTaskRun } from "./taskRunState.ts";
import { createWorktreeForGroup } from "../../prepareTasks.ts";
import { resolveTaskFiles } from "../../taskFiles.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = tmpMkdir("commit-task-work-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
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

function seedTaskAndClaim(rootOrigin: string, taskNumber: number, title: string, runId: string, files: string[]): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title, files }]);
    const outcome = claimTask(taskNumber, runId, rootOrigin);
    assert.equal(outcome.status, "claimed");
}

test("test_commitTaskWork_commitsDeepestFirstAndBumpsTheParentGitlink", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9001;
    seedTaskAndClaim(rootOrigin, taskNumber, "add a widget", "run-1", ["child/widget.txt", "root-widget.txt"]);

    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    writeFileSync(join(worktreePath, "root-widget.txt"), "root widget\n");

    const result = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "step-1", rootSourceBranch: "main" });

    assert.equal(result.commits.length, 2);
    assert.equal(result.commits[0].occurrenceId, "child");
    assert.equal(result.commits[1].occurrenceId, "");
    // The parent's commit must include the bumped child gitlink.
    const parentDiffStat = git(worktreePath, "show", "--stat", result.commits[1].hash);
    assert.match(parentDiffStat, /child/);
    assert.match(parentDiffStat, /root-widget\.txt/);
});

test("test_commitTaskWork_stagesAnOwnedPathDeclaredUnderModifiableFilesInsteadOfLegacyFiles", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9004;
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "modern task", modifiableFiles: ["modern-widget.txt"] }]);
    claimTask(taskNumber, "run-1", rootOrigin);

    writeFileSync(join(worktreePath, "modern-widget.txt"), "modern widget\n");

    const result = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "step-1", rootSourceBranch: "main" });

    assert.equal(result.commits.length, 1);
    const diffStat = git(worktreePath, "show", "--stat", result.commits[0].hash);
    assert.match(diffStat, /modern-widget\.txt/);
});

test("test_commitTaskWork_returnsNoCommitsWhenEveryLayerIsClean", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9002;
    seedTaskAndClaim(rootOrigin, taskNumber, "no-op task", "run-1", []);

    const result = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "step-1", rootSourceBranch: "main" });

    assert.deepEqual(result.commits, []);
});

test("test_commitTaskWork_usesTheWorkKindForTheFirstCommitAndRepairForEveryLater", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9003;
    seedTaskAndClaim(rootOrigin, taskNumber, "fix the thing", "run-1", ["first.txt", "second.txt"]);

    writeFileSync(join(worktreePath, "first.txt"), "first\n");
    const first = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "step-1", rootSourceBranch: "main" });
    assert.equal(first.commits.length, 1);
    assert.equal(first.commits[0].kind, "work");
    assert.match(git(worktreePath, "log", "-1", "--format=%s"), /fix the thing/);

    writeFileSync(join(worktreePath, "second.txt"), "second\n");
    const second = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "step-2", rootSourceBranch: "main" });
    assert.equal(second.commits.length, 1);
    assert.equal(second.commits[0].kind, "repair");
    assert.match(git(worktreePath, "log", "-1", "--format=%s"), /fixed code making tests fail/);

    const run = getCurrentTaskRun(taskNumber, rootOrigin);
    assert.equal(run?.commits.length, 2);
    assert.deepEqual(run?.commits.map((commit) => commit.kind), ["work", "repair"]);
});

test("test_commitTaskWork_commitsARenamedOwnedFileNextToAStagedDeletion", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9006;
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "move task", modifiableFiles: ["seed.txt", "moved/seed.txt", "gone.txt"] }]);
    claimTask(taskNumber, "run-1", rootOrigin);

    writeFileSync(join(worktreePath, "gone.txt"), "gone\n");
    git(worktreePath, "add", "gone.txt");
    git(worktreePath, "commit", "-q", "-m", "add gone");
    git(worktreePath, "rm", "-q", "gone.txt");
    mkdirSync(join(worktreePath, "moved"));
    git(worktreePath, "mv", "seed.txt", "moved/seed.txt");
    writeFileSync(join(worktreePath, "moved/seed.txt"), "seed edited\n");

    const result = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "step-1", rootSourceBranch: "main" });

    assert.equal(result.commits.length, 1);
    assert.equal(git(worktreePath, "status", "--porcelain"), "");
    const names = git(worktreePath, "show", "--name-status", "--format=", result.commits[0].hash);
    assert.match(names, /moved\/seed\.txt/);
    assert.match(names, /D\tgone\.txt/);
});
