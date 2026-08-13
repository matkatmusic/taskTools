// Behavioral checks for scripts/tackle-tasks/mergeTaskWorktree.ts. Run: node --test tests/tackle-tasks/mergeTaskWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeTaskWorktree } from "../../scripts/tackle-tasks/mergeTaskWorktree.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";
import { currentBranchName } from "../../scripts/repositoryBranches.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempRepoWithTestScript(branchName: string): string {
    const repoPath = tmpMkdir("merge-task-worktree-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeTempRepoWithTestScript("child-main");
    const rootOrigin = makeTempRepoWithTestScript("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return rootOrigin;
}

let nextGroupId = 1;
// operationBranch is attached as "task-<taskNumber>" by the script under test, so taskNumber
// here must equal the worktree's real groupId - matching production's one-task-per-group.
function createLinkedWorktree(rootOrigin: string): { worktreePath: string; taskNumber: number } {
    const groupId = nextGroupId++;
    const worktreePath = createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
    return { worktreePath, taskNumber: groupId };
}

function commitTaskWorkInWorktree(worktreePath: string): void {
    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    git(join(worktreePath, "child"), "add", "widget.txt");
    git(join(worktreePath, "child"), "commit", "-q", "-m", "child work");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    writeFileSync(join(worktreePath, "root-work.txt"), "root work\n");
    git(worktreePath, "add", "root-work.txt");
    git(worktreePath, "commit", "-q", "-m", "root work");
}

test("test_mergeTaskWorktree_mergesEveryLayerAndReturnsMergeCommits", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    commitTaskWorkInWorktree(worktreePath);
    const sourceBranch = currentBranchName(rootOrigin);

    const result = mergeTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-30", rootSourceBranch: sourceBranch,
    });

    assert.equal(result.merged, true);
    assert.equal(result.failureReason, null);
    assert.deepEqual(result.commits.map((commit) => commit.kind), ["merge", "merge"]);
    assert.deepEqual(result.commits.map((commit) => commit.occurrenceId).sort(), ["", "child"]);
});

test("test_mergeTaskWorktree_createsAMergeCommitWithTwoParents", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    commitTaskWorkInWorktree(worktreePath);
    const sourceBranch = currentBranchName(rootOrigin);

    const result = mergeTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-31", rootSourceBranch: sourceBranch,
    });
    assert.equal(result.merged, true);

    const rootMergeCommit = result.commits.find((commit) => commit.occurrenceId === "")!;
    const parents = git(rootOrigin, "log", "-1", "--format=%P", rootMergeCommit.hash).split(" ").filter(Boolean);
    assert.equal(parents.length, 2);
});

test("test_mergeTaskWorktree_refusesWhenTheSourceCheckoutWentDirty", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    commitTaskWorkInWorktree(worktreePath);
    const sourceBranch = currentBranchName(rootOrigin);

    // An unrelated dirty change lands in the source checkout while the lock was held.
    writeFileSync(join(rootOrigin, "uncommitted.txt"), "oops\n");

    assert.throws(() => mergeTaskWorktree({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-32", rootSourceBranch: sourceBranch,
    }), /dirty/);
});
