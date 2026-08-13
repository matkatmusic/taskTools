// Behavioral checks for scripts/tackle-tasks/cleanupTaskWorktree.ts. Run: node --test tests/tackle-tasks/cleanupTaskWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTaskWorktree } from "../../scripts/tackle-tasks/cleanupTaskWorktree.ts";
import { acquireSourceRepoLock, buildLockOwner, readSourceRepoLock } from "../../scripts/tackle-tasks/sourceRepoLock.ts";
import { createWorktreeForGroup, readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../../scripts/prepareTasks.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = tmpMkdir("cleanup-worktree-");
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
function createLinkedWorktree(rootOrigin: string, runId: string): { worktreePath: string; taskNumber: number; branchName: string } {
    const groupId = nextGroupId++;
    const worktreePath = createWorktreeForGroup(
        rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" }, runId,
    );
    return { worktreePath, taskNumber: groupId, branchName: `task-${groupId}` };
}

function markPersistenceRefs(checkoutPath: string, branchName: string): void {
    const head = git(checkoutPath, "rev-parse", "HEAD");
    git(checkoutPath, "update-ref", `refs/taskTools/merged-commits/${branchName}`, head);
    git(checkoutPath, "update-ref", `refs/taskTools/merge-intents/${branchName}`, head);
}

function hasRef(checkoutPath: string, ref: string): boolean {
    try {
        git(checkoutPath, "rev-parse", "--verify", ref);
        return true;
    } catch {
        return false;
    }
}

test("test_cleanupTaskWorktree_deletesPersistenceRefsInEverySourceOccurrence", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-50";
    const { worktreePath, taskNumber, branchName } = createLinkedWorktree(rootOrigin, runId);
    markPersistenceRefs(rootOrigin, branchName);
    markPersistenceRefs(join(rootOrigin, "child"), branchName);

    const result = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId, branchName });

    assert.equal(result.removed, true);
    assert.equal(hasRef(rootOrigin, `refs/taskTools/merged-commits/${branchName}`), false);
    assert.equal(hasRef(rootOrigin, `refs/taskTools/merge-intents/${branchName}`), false);
    assert.equal(hasRef(join(rootOrigin, "child"), `refs/taskTools/merged-commits/${branchName}`), false);
    assert.equal(hasRef(join(rootOrigin, "child"), `refs/taskTools/merge-intents/${branchName}`), false);
});

test("test_cleanupTaskWorktree_leavesEverySourceCheckoutClean", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-51";
    const { worktreePath, taskNumber, branchName } = createLinkedWorktree(rootOrigin, runId);

    const result = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId, branchName });

    assert.equal(result.removed, true);
    assert.equal(git(rootOrigin, "status", "--porcelain"), "");
    assert.equal(git(join(rootOrigin, "child"), "status", "--porcelain"), "");
});

test("test_cleanupTaskWorktree_keepsTheLeaseWhenWorktreeRemovalFails", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-52";
    const { worktreePath, taskNumber, branchName } = createLinkedWorktree(rootOrigin, runId);
    const owner = buildLockOwner(runId, taskNumber);
    assert.equal(acquireSourceRepoLock(rootOrigin, owner).status, "acquired");

    git(rootOrigin, "worktree", "lock", worktreePath, "--reason", "test");

    const result = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId, branchName });

    assert.equal(result.removed, false);
    assert.ok(result.retainedArtifacts.includes(worktreePath));
    assert.notEqual(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath)), null);
    assert.equal(readSourceRepoLock(rootOrigin)?.owner, owner);

    git(rootOrigin, "worktree", "unlock", worktreePath);
});

test("test_cleanupTaskWorktree_succeedsWhenRunTwice", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-53";
    const { worktreePath, taskNumber, branchName } = createLinkedWorktree(rootOrigin, runId);

    const first = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId, branchName });
    assert.equal(first.removed, true);
    assert.equal(existsSync(worktreePath), false);

    const second = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId, branchName });
    assert.equal(second.removed, true);
    assert.deepEqual(second.retainedArtifacts, []);
});
