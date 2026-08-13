// Behavioral checks for scripts/tackle-tasks/commitTaskWork.ts. Run: node --test tests/tackle-tasks/commitTaskWork.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitTaskWork } from "../../scripts/tackle-tasks/commitTaskWork.ts";
import { claimTask, getCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../scripts/taskStateLock.ts";

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

function seedTaskAndClaim(rootOrigin: string, taskNumber: number, title: string, runId: string): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title, files: [] }]);
    const outcome = claimTask(taskNumber, runId, rootOrigin);
    assert.equal(outcome.status, "claimed");
}

test("test_commitTaskWork_commitsDeepestFirstAndBumpsTheParentGitlink", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9001;
    seedTaskAndClaim(rootOrigin, taskNumber, "add a widget", "run-1");

    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    writeFileSync(join(worktreePath, "root-widget.txt"), "root widget\n");

    const result = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", rootSourceBranch: "main" });

    assert.equal(result.commits.length, 2);
    assert.equal(result.commits[0].occurrenceId, "child");
    assert.equal(result.commits[1].occurrenceId, "");
    // The parent's commit must include the bumped child gitlink.
    const parentDiffStat = git(worktreePath, "show", "--stat", result.commits[1].hash);
    assert.match(parentDiffStat, /child/);
    assert.match(parentDiffStat, /root-widget\.txt/);
});

test("test_commitTaskWork_returnsNoCommitsWhenEveryLayerIsClean", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9002;
    seedTaskAndClaim(rootOrigin, taskNumber, "no-op task", "run-1");

    const result = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", rootSourceBranch: "main" });

    assert.deepEqual(result.commits, []);
});

test("test_commitTaskWork_usesTheWorkKindForTheFirstCommitAndRepairForEveryLater", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9003;
    seedTaskAndClaim(rootOrigin, taskNumber, "fix the thing", "run-1");

    writeFileSync(join(worktreePath, "first.txt"), "first\n");
    const first = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", rootSourceBranch: "main" });
    assert.equal(first.commits.length, 1);
    assert.equal(first.commits[0].kind, "work");
    assert.match(git(worktreePath, "log", "-1", "--format=%s"), /fix the thing/);

    writeFileSync(join(worktreePath, "second.txt"), "second\n");
    const second = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", rootSourceBranch: "main" });
    assert.equal(second.commits.length, 1);
    assert.equal(second.commits[0].kind, "repair");
    assert.match(git(worktreePath, "log", "-1", "--format=%s"), /fixed code making tests fail/);

    const run = getCurrentTaskRun(taskNumber, rootOrigin);
    assert.equal(run?.commits.length, 2);
    assert.deepEqual(run?.commits.map((commit) => commit.kind), ["work", "repair"]);
});
