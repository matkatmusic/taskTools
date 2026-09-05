// Behavioral checks for CLEAN_UP_WORKTREES.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./CLEAN_UP_WORKTREES.ts";
import { acquireSourceRepoLock, buildLockOwner, readSourceRepoLock } from "../shared/sourceRepoLock.ts";
import { taskBranchName } from "../shared/createTaskWorktree.ts";
import { cleanupTaskWorktree } from "../shared/cleanupTaskWorktree.ts";
import { claimTask, readTaskRunState, writeTailCursor } from "../shared/taskRunState.ts";
import { findResumeEntry } from "../shared/resumeRun.ts";
import { createWorktreeForGroup, readTaskWorktreeLeaseOwner, taskWorktreeLeasePath } from "../../prepareTasks.ts";
import { getTemplateShapeMismatches } from "../../templateShape.ts";
import { resolveTaskFiles } from "../../taskFiles.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";
import { git, makeCommittedRepo, addSubmodule } from "../../../tests/support/gitFixtures.ts";

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), "CLEAN_UP_WORKTREES.template.json");

function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeCommittedRepo("clean-up-worktrees-child-", "child-main");
    const rootOrigin = makeCommittedRepo("clean-up-worktrees-root-", "main");
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

function samplePacket(projectRoot: string, taskNumber: number, runId: string, worktree: string): Record<string, unknown> {
    return { box: "RECORD_MODIFIED_FILES_SUCCESS", scriptSignal: "continue", projectRoot, taskNumber, runId, worktree };
}

function seedTaskAndClaim(rootOrigin: string, taskNumber: number, runId: string): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(dirname(tasksPath), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t" }]);
    const outcome = claimTask(taskNumber, runId, rootOrigin);
    assert.equal(outcome.status, "claimed");
}

test("test_CLEAN_UP_WORKTREES_leavesEverySourceCheckoutClean", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-51";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");
    // Seeding the task record writes .taskTools/tasks.json, which is untracked in this fixture;
    // compare against the status right before cleanup runs, not against an empty string.
    const statusBefore = git(rootOrigin, "status", "--porcelain");

    const output = main(JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath)));

    assert.equal(output.box, "CLEAN_UP_WORKTREES");
    assert.equal("worktree" in output, false);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(git(rootOrigin, "status", "--porcelain"), statusBefore);
    assert.equal(git(join(rootOrigin, "child"), "status", "--porcelain"), "");

    const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
    assert.deepEqual(getTemplateShapeMismatches(template.output, output), []);
});

test("test_CLEAN_UP_WORKTREES_runsTwiceWithTheSameInput", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-52";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");
    const input = JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath));

    const first = main(input);
    const second = main(input);

    assert.deepEqual(second, first);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(readSourceRepoLock(rootOrigin), null);
});

// A lock owned by another run must refuse before any mutation.
test("test_CLEAN_UP_WORKTREES_refusesAndMutatesNothingWhenTheSourceLockIsOwnedByAnotherRun", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-54";
    const { worktreePath, taskNumber, branchName } = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    const otherOwner = buildLockOwner("run-other", 999);
    assert.equal(acquireSourceRepoLock(rootOrigin, otherOwner).status, "acquired");

    assert.throws(() => main(JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath))));

    assert.equal(existsSync(worktreePath), true);
    assert.equal(git(rootOrigin, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`).length > 0, true);
    assert.notEqual(readTaskWorktreeLeaseOwner(taskWorktreeLeasePath(worktreePath)), null);
    assert.equal(readSourceRepoLock(rootOrigin)?.owner, otherOwner);
});

test("test_CLEAN_UP_WORKTREES_clearsTheTailCursorOnceFullyClean", () => {
    // Setup: a claimed task with a linked worktree and the source lock held.
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-60";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");

    // Test action: run CLEAN_UP_WORKTREES to full success.
    main(JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath)));

    // Verification: no tail cursor is left once cleanup is verifiably complete.
    const state = readTaskRunState(taskNumber, rootOrigin);
    assert.equal(state.history[0].tailCursor, null);
});

test("test_CLEAN_UP_WORKTREES_leavesTheTailCursorOnAThrowAndTheRetrySucceeds", () => {
    // Setup: a claimed task with a linked worktree, the source lock held, and worktree removal
    // rigged to fail (git worktree lock, the same technique cleanupTaskWorktree.test.ts uses).
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-61";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");
    git(rootOrigin, "worktree", "lock", worktreePath, "--reason", "test");
    const input = JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath));

    // Test action: the first attempt throws (removal is locked). cleanupTaskWorktree's own catch
    // releases the source lock even though cleanup did not finish (its existing, correct behavior).
    assert.throws(() => main(input));

    // Verification: the tail cursor survives the throw, naming this exact box and input.
    const afterThrow = readTaskRunState(taskNumber, rootOrigin);
    assert.deepEqual(afterThrow.history[0].tailCursor, {
        block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input,
    });
    assert.equal(readSourceRepoLock(rootOrigin), null);

    // Test action: unlock, then retry with the exact cursor input (what resumeRun.ts would replay).
    // No manual re-acquire here: main() itself must reacquire the now-absent lock before retrying.
    git(rootOrigin, "worktree", "unlock", worktreePath);
    main(afterThrow.history[0].tailCursor!.input);

    // Verification: the retry finishes cleanup and clears the cursor.
    const afterRetry = readTaskRunState(taskNumber, rootOrigin);
    assert.equal(afterRetry.history[0].tailCursor, null);
    assert.equal(existsSync(worktreePath), false);
});

test("test_CLEAN_UP_WORKTREES_resumeReplaysAfterTheWrapperDiesBetweenCleanupSucceedingAndClearingTheCursor", () => {
    // Setup: a claimed task with a linked worktree and the source lock held; the cursor is written
    // exactly like main()'s first line would, simulating that CLEAN_UP_WORKTREES already started.
    const rootOrigin = makeSourceRepoWithSubmodule();
    const runId = "run-62";
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin, runId);
    seedTaskAndClaim(rootOrigin, taskNumber, runId);
    assert.equal(acquireSourceRepoLock(rootOrigin, buildLockOwner(runId, taskNumber)).status, "acquired");
    const input = JSON.stringify(samplePacket(rootOrigin, taskNumber, runId, worktreePath));
    writeTailCursor(taskNumber, runId, { block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input }, rootOrigin);

    // Test action: cleanupTaskWorktree runs to full completion directly — as if main() had called
    // it and the process died right after, before main() could clear the cursor. The worktree and
    // its checkpoint are gone, but the durable cursor (in tasks.json, outside the worktree) survives.
    const result = cleanupTaskWorktree({ projectRoot: rootOrigin, worktreePath, taskNumber, runId, rootSourceBranch: "staging" });
    assert.equal(result.removed, true);
    assert.equal(existsSync(worktreePath), false);
    assert.deepEqual(readTaskRunState(taskNumber, rootOrigin).history[0].tailCursor, {
        block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input,
    });

    // Test action: resume finds the cursor (the worktree checkpoint is gone, so row 2 cannot fire)
    // and replays CLEAN_UP_WORKTREES with its exact input.
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    const entry = findResumeEntry(taskNumber, tasksPath);
    assert.deepEqual(entry, { block: "pipeline-mergeSucceededExit.mmd::CLEAN_UP_WORKTREES", input });
    main(entry!.input);

    // Verification: the replay is a no-op cleanup (cleanupTaskWorktree's own F2 early return, and
    // test_cleanupTaskWorktree_succeedsWhenRunTwice already proves this is safe) that reacquires
    // the lock this run needs, finds nothing left to do, and clears the cursor.
    assert.equal(readTaskRunState(taskNumber, rootOrigin).history[0].tailCursor, null);
});
