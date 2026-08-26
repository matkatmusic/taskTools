// Behavioral checks for scripts/tackle-tasks/cleanupTaskWorktree.ts. Run: node --test tests/cleanupTaskWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTaskWorktree } from "../scripts/tackle-tasks/cleanupTaskWorktree.ts";
import { acquireSourceRepoLock, buildLockOwner, readSourceRepoLock } from "../scripts/tackle-tasks/sourceRepoLock.ts";
import { taskBranchName } from "../scripts/tackle-tasks/createTaskWorktree.ts";
import { adoptWorktreeLease, claimTask } from "../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup, readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../scripts/taskFiles.ts";
import { git, makeCommittedRepo, addSubmodule } from "./support/gitFixtures.ts";

function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeCommittedRepo("cleanup-worktree-child-", "child-main");
    const rootOrigin = makeCommittedRepo("cleanup-worktree-root-", "main");
    addSubmodule(rootOrigin, childOrigin, "child");
    return rootOrigin;
}

let nextGroupId = 1;
function createLinkedWorktree(rootOrigin: string, runId: string): { worktreePath: string; taskNumber: number; branchName: string } {
    const groupId = nextGroupId++;
    const worktreePath = createWorktreeForGroup(
        rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" }, runId,
    );
    return { worktreePath, taskNumber: groupId, branchName: taskBranchName(groupId) };
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

function hasBranch(checkoutPath: string, branchName: string): boolean {
    return hasRef(checkoutPath, `refs/heads/${branchName}`);
}

test("test_cleanupTaskWorktree_deletesPersistenceRefsInEverySourceOccurrence", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-50";
    const { worktreePath, taskNumber, branchName } = createLinkedWorktree(rootOrigin, runId);
    markPersistenceRefs(rootOrigin, branchName);
    markPersistenceRefs(join(rootOrigin, "child"), branchName);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");

    const result = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId });

    assert.equal(result.removed, true);
    assert.equal(hasRef(rootOrigin, `refs/taskTools/merged-commits/${branchName}`), false);
    assert.equal(hasRef(rootOrigin, `refs/taskTools/merge-intents/${branchName}`), false);
    assert.equal(hasRef(join(rootOrigin, "child"), `refs/taskTools/merged-commits/${branchName}`), false);
    assert.equal(hasRef(join(rootOrigin, "child"), `refs/taskTools/merge-intents/${branchName}`), false);
});

test("test_cleanupTaskWorktree_leavesEverySourceCheckoutClean", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-51";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");

    const result = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId });

    assert.equal(result.removed, true);
    assert.equal(git(rootOrigin, "status", "--porcelain"), "");
    assert.equal(git(join(rootOrigin, "child"), "status", "--porcelain"), "");
});

// F5: worktree-removal failure is an operational failure, never a returned {removed:false}. It
// must throw with the original cause and the retained artifacts, and it must not release the
// worktree lease - only the source lock.
test("test_cleanupTaskWorktree_keepsTheLeaseWhenWorktreeRemovalFails", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-52";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    const owner = buildLockOwner(runId, taskNumber);
    assert.equal(acquireSourceRepoLock(rootOrigin, owner).status, "acquired");

    git(rootOrigin, "worktree", "lock", worktreePath, "--reason", "test");

    assert.throws(
        () => cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId }),
        (error: Error) => error.message.includes("retained artifacts") && error.message.includes(worktreePath),
    );

    // The worktree lease remains - the next run needs a live marker to adopt it.
    assert.notEqual(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath)), null);
    // The source lock is always released so unrelated tasks can proceed.
    assert.equal(readSourceRepoLock(rootOrigin), null);

    git(rootOrigin, "worktree", "unlock", worktreePath);
});

test("test_cleanupTaskWorktree_succeedsWhenRunTwice", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-53";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");

    const first = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId });
    assert.equal(first.removed, true);
    assert.equal(existsSync(worktreePath), false);

    // Simulate a lost stdout result: call again with nothing left to observe from the first call.
    const second = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId });
    assert.equal(second.removed, true);
    assert.deepEqual(second.retainedArtifacts, []);
});

// F2 consumer half: a lock owned by another run must refuse before any mutation, since retained
// artifacts (the worktree, its branch) still exist - a missing lock alone is not proof of
// completion, but an unowned lock must still stop the script cold.
test("test_cleanupTaskWorktree_refusesAndMutatesNothingWhenTheSourceLockIsOwnedByAnotherRun", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-54";
    const { worktreePath, taskNumber, branchName } = createLinkedWorktree(rootOrigin, runId);
    const otherOwner = buildLockOwner("run-other", 999);
    assert.equal(acquireSourceRepoLock(rootOrigin, otherOwner).status, "acquired");

    assert.throws(() => cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId }));

    assert.equal(existsSync(worktreePath), true);
    assert.equal(hasBranch(rootOrigin, branchName), true);
    assert.notEqual(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath)), null);
    assert.equal(readSourceRepoLock(rootOrigin)?.owner, otherOwner);
});

// F5 lease lifecycle: after a cleanup failure retains the lease, a resumed run must be able to
// adopt it atomically before doing any new work - the whole point of not releasing it.
test("test_cleanupTaskWorktree_aNewRunAdoptsTheRetainedLeaseAfterCleanupFailure", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const oldRunId = "run-55-old";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, oldRunId);
    const owner = buildLockOwner(oldRunId, taskNumber);
    assert.equal(acquireSourceRepoLock(rootOrigin, owner).status, "acquired");
    git(rootOrigin, "worktree", "lock", worktreePath, "--reason", "test");

    assert.throws(() => cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: oldRunId }));
    git(rootOrigin, "worktree", "unlock", worktreePath);

    // Seed tasks.json the way the pipeline would have left it: the old run ended run-failed,
    // still naming the worktree and the retained lease.
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeFileSync(tasksPath, JSON.stringify([{
        taskNumber, title: "t",
        run: {
            active: false, worktree: worktreePath, leaseRunId: oldRunId,
            history: [{
                runId: oldRunId, startedAt: "2026-08-01T00:00:00-07:00", endedAt: "2026-08-01T00:05:00-07:00",
                exitType: "run-failed", exitNote: "cleanup failed", modifiedFiles: [], commits: [],
                implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }], null, 2));

    // A new run claims the task and adopts the retained lease before touching any work.
    const newRunId = "run-55-new";
    const claimOutcome = claimTask(taskNumber, newRunId, rootOrigin);
    assert.equal(claimOutcome.status, "claimed");
    const adoption = adoptWorktreeLease(taskNumber, newRunId, rootOrigin);
    assert.equal(adoption.adopted, true);
    const leaseFile = JSON.parse(readFileSync(taskWorktreeLeasePath(worktreePath), "utf8"));
    assert.equal(leaseFile.runId, newRunId);

    // Cleanup by the new run now succeeds and releases everything.
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(newRunId, taskNumber)).status, "acquired");
    const finalResult = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: newRunId });
    assert.equal(finalResult.removed, true);
    assert.equal(existsSync(worktreePath), false);
});
