// Real-git tests for Q_CATCH_UP_STAGING: staging behind, staging diverged and clean, staging diverged with a conflict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./CATCH_UP_STAGING.ts";
import { acquireSourceRepoLock, buildLockOwner, readSourceRepoLock } from "../shared/sourceRepoLock.ts";
import { resolveTaskWorktreeConventionDirectory } from "../../shared/prepareTasks.ts";
import { git } from "../../../tests/support/gitFixtures.ts";
import { makeShapeFixture } from "../../../tests/support/repoShapeFixtures.ts";

// runId is "" before B_MARK_TASK_ACTIVE, so B_LOCK_STAGING_FOR_CATCH_UP takes the lock as ":<taskNumber>".
const inputFor = (projectRoot: string, taskNumber: number): string => JSON.stringify({
    box: "Q_WAS_CATCH_UP_LOCK_ACQUIRED_Q",
    scriptSignal: "continue",
    next: "Q_CATCH_UP_STAGING",
    taskNumber,
    runId: "",
    projectRoot,
    worktree: "",
    branch: `task-${taskNumber}`,
    docsMode: "",
    planFile: "",
    exitType: "",
    exitNote: "",
    lockWaitStartedAt: "2024-01-01T00:00:00.000Z",
});

test("test_catchUpStaging_movesStagingForwardWhenBehind", () => {
    // Setup: staging is one commit behind main, and this run holds the source-repo lock.
    const fixture = makeShapeFixture("none", "behind-head", 710);
    assert.equal(acquireSourceRepoLock(fixture.rootPath, buildLockOwner("", 710)).status, "acquired");

    // Test action: run the block.
    const result = main(inputFor(fixture.rootPath, 710));

    // Verification: the walk goes on to B_MARK_TASK_ACTIVE with the lock released and staging at main.
    assert.equal(result.box, "Q_CATCH_UP_STAGING");
    assert.equal(result.next, "B_MARK_TASK_ACTIVE");
    assert.equal(readSourceRepoLock(fixture.rootPath), null);
    assert.equal(git(fixture.rootPath, "rev-parse", "staging"), git(fixture.rootPath, "rev-parse", "main"));
    // Verification: the lock wait clock stays inside the four catch-up lock blocks.
    assert.equal("lockWaitStartedAt" in result, false);
});

test("test_catchUpStaging_mergesCleanlyWhenDiverged", () => {
    // Setup: staging holds a prior task's merge commit, and main gains one commit on a different file.
    const fixture = makeShapeFixture("none", "ahead-head", 711);
    const priorStagingTip = git(fixture.rootPath, "rev-parse", "staging");
    writeFileSync(join(fixture.rootPath, "diverge.txt"), "head\n");
    git(fixture.rootPath, "add", "diverge.txt");
    git(fixture.rootPath, "commit", "-q", "-m", "diverge head past staging");
    const headTip = git(fixture.rootPath, "rev-parse", "main");
    assert.equal(acquireSourceRepoLock(fixture.rootPath, buildLockOwner("", 711)).status, "acquired");

    // Test action: run the block.
    const result = main(inputFor(fixture.rootPath, 711));

    // Verification: the lock is released and staging is a merge of the prior staging tip and main.
    assert.equal(result.next, "B_MARK_TASK_ACTIVE");
    assert.equal(readSourceRepoLock(fixture.rootPath), null);
    const parents = git(fixture.rootPath, "log", "-1", "--pretty=%P", "staging").split(" ").sort();
    assert.deepEqual(parents, [priorStagingTip, headTip].sort());
    // Verification: the merge worktree is gone.
    assert.equal(existsSync(join(resolveTaskWorktreeConventionDirectory(fixture.rootPath), "task-711-catchUpMerge")), false);
});

test("test_catchUpStaging_keepsTheLockAndRoutesToFixOnConflict", () => {
    // Setup: staging and main both change the one line of seed.txt.
    const fixture = makeShapeFixture("none", "at-head", 712);
    git(fixture.rootPath, "checkout", "-q", "staging");
    writeFileSync(join(fixture.rootPath, "seed.txt"), "staging line\n");
    git(fixture.rootPath, "commit", "-q", "-am", "staging edits seed");
    git(fixture.rootPath, "checkout", "-q", "main");
    writeFileSync(join(fixture.rootPath, "seed.txt"), "head line\n");
    git(fixture.rootPath, "commit", "-q", "-am", "head edits seed");
    const owner = buildLockOwner("", 712);
    assert.equal(acquireSourceRepoLock(fixture.rootPath, owner).status, "acquired");

    // Test action: run the block.
    const result = main(inputFor(fixture.rootPath, 712));

    // Verification: the walk goes to B_FIX_CATCH_UP_CONFLICTS with the repository and the merge worktree path, and no file list.
    const expectedWorktreePath = join(resolveTaskWorktreeConventionDirectory(fixture.rootPath), "task-712-catchUpMerge");
    assert.equal(result.next, "B_FIX_CATCH_UP_CONFLICTS");
    assert.equal(result.repository, fixture.rootPath);
    assert.equal(result.worktreePath, expectedWorktreePath);
    assert.deepEqual(Object.keys(result).sort(), [
        "box", "branch", "docsMode", "exitNote", "exitType", "next", "planFile", "projectRoot",
        "repository", "runId", "scriptSignal", "taskNumber", "worktree", "worktreePath",
    ]);
    // Verification: the merge worktree is still there with seed.txt unmerged.
    assert.equal(git(expectedWorktreePath, "status", "--porcelain"), "UU seed.txt");
    // Verification: the lock is still held by the owner B_LOCK_STAGING_FOR_CATCH_UP used.
    assert.equal(readSourceRepoLock(fixture.rootPath)?.owner, owner);
});
