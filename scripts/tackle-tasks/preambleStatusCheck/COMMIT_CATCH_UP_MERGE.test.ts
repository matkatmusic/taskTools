// Real-git tests for Q_COMMIT_CATCH_UP_MERGE: a fixed merge is committed; a leftover marker goes back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "./COMMIT_CATCH_UP_MERGE.ts";
import { acquireSourceRepoLock, buildLockOwner, readSourceRepoLock } from "../shared/sourceRepoLock.ts";
import { catchUpStaging } from "../../shared/catchUpStaging.ts";
import { git } from "../../../tests/support/gitFixtures.ts";
import { makeShapeFixture } from "../../../tests/support/repoShapeFixtures.ts";

// staging and main both change the one line of seed.txt, so catchUpStaging stops in task-N-catchUpMerge.
function makeStoppedCatchUpMerge(taskNumber: number): { rootPath: string; worktreePath: string; stagingBefore: string; headTip: string } {
    const fixture = makeShapeFixture("none", "at-head", taskNumber);
    git(fixture.rootPath, "checkout", "-q", "staging");
    writeFileSync(join(fixture.rootPath, "seed.txt"), "staging line\n");
    git(fixture.rootPath, "commit", "-q", "-am", "staging edits seed");
    git(fixture.rootPath, "checkout", "-q", "main");
    writeFileSync(join(fixture.rootPath, "seed.txt"), "head line\n");
    git(fixture.rootPath, "commit", "-q", "-am", "head edits seed");
    const stagingBefore = git(fixture.rootPath, "rev-parse", "staging");
    const headTip = git(fixture.rootPath, "rev-parse", "main");
    const conflict = catchUpStaging(fixture.rootPath, taskNumber);
    assert.notEqual(conflict, null);
    // B_FIX_CATCH_UP_CONFLICTS leaves its prompt file untracked in the merge worktree.
    mkdirSync(join(conflict!.worktreePath, "plans"), { recursive: true });
    writeFileSync(join(conflict!.worktreePath, "plans", "FIX_CATCH_UP_CONFLICTS.prompt.md"), "prompt\n");
    return { rootPath: fixture.rootPath, worktreePath: conflict!.worktreePath, stagingBefore, headTip };
}

// What the hook hands on after B_FIX_CATCH_UP_CONFLICTS: Q_CATCH_UP_STAGING's conflict output plus the agent's answer.
const inputFor = (projectRoot: string, worktreePath: string, taskNumber: number): string => JSON.stringify({
    box: "Q_CATCH_UP_STAGING",
    scriptSignal: "continue",
    next: "B_FIX_CATCH_UP_CONFLICTS",
    taskNumber,
    runId: "",
    projectRoot,
    worktree: "",
    branch: `task-${taskNumber}`,
    docsMode: "",
    planFile: "",
    exitType: "",
    exitNote: "",
    repository: projectRoot,
    worktreePath,
    message: "",
    additionalData: { resolved: true, unresolvedPaths: [] },
});

test("test_commitCatchUpMerge_stagesAndCommitsWhenNoMarkerRemains", () => {
    // Setup: the agent resolved seed.txt without git add, and this run holds the source-repo lock.
    const stopped = makeStoppedCatchUpMerge(720);
    writeFileSync(join(stopped.worktreePath, "seed.txt"), "resolved line\n");
    const owner = buildLockOwner("", 720);
    assert.equal(acquireSourceRepoLock(stopped.rootPath, owner).status, "acquired");

    // Test action: run the block.
    const result = main(inputFor(stopped.rootPath, stopped.worktreePath, 720));

    // Verification: the walk goes back to Q_CATCH_UP_STAGING with the lock still held.
    assert.equal(result.box, "Q_COMMIT_CATCH_UP_MERGE");
    assert.equal(result.next, "Q_CATCH_UP_STAGING");
    assert.equal(readSourceRepoLock(stopped.rootPath)?.owner, owner);
    // Verification: staging merges its old tip and main, with the resolved file and no prompt file.
    const parents = git(stopped.rootPath, "log", "-1", "--pretty=%P", "staging").split(" ").sort();
    assert.deepEqual(parents, [stopped.stagingBefore, stopped.headTip].sort());
    assert.equal(git(stopped.rootPath, "show", "staging:seed.txt"), "resolved line");
    assert.equal(git(stopped.rootPath, "ls-tree", "-r", "--name-only", "staging", "--", "plans"), "");
    // Verification: the merge worktree is gone, and the next catch-up pass finds nothing left to merge.
    assert.equal(existsSync(stopped.worktreePath), false);
    assert.doesNotMatch(git(stopped.rootPath, "worktree", "list"), /catchUpMerge/);
    assert.equal(catchUpStaging(stopped.rootPath, 720), null);
});

test("test_commitCatchUpMerge_keepsTheLockAndGoesBackToFixWhenAMarkerRemains", () => {
    // Setup: seed.txt still holds the conflict markers, and this run holds the source-repo lock.
    const stopped = makeStoppedCatchUpMerge(721);
    const owner = buildLockOwner("", 721);
    assert.equal(acquireSourceRepoLock(stopped.rootPath, owner).status, "acquired");

    // Test action: run the block.
    const result = main(inputFor(stopped.rootPath, stopped.worktreePath, 721));

    // Verification: the walk goes back to B_FIX_CATCH_UP_CONFLICTS with the merge worktree path and the lock.
    assert.equal(result.next, "B_FIX_CATCH_UP_CONFLICTS");
    assert.equal(result.worktreePath, stopped.worktreePath);
    assert.equal(readSourceRepoLock(stopped.rootPath)?.owner, owner);
    // Verification: nothing was staged, committed, or removed.
    assert.match(git(stopped.worktreePath, "status", "--porcelain"), /^UU seed\.txt$/m);
    assert.equal(git(stopped.rootPath, "rev-parse", "staging"), stopped.stagingBefore);
    assert.equal(existsSync(stopped.worktreePath), true);
});

test("test_commitCatchUpMerge_throwsWhenTheSourceLockIsNotHeldByThisRun", () => {
    // Setup: the agent resolved seed.txt, but no lock was acquired.
    const stopped = makeStoppedCatchUpMerge(722);
    writeFileSync(join(stopped.worktreePath, "seed.txt"), "resolved line\n");

    // Test action and verification: the block throws before it commits anything.
    assert.throws(() => main(inputFor(stopped.rootPath, stopped.worktreePath, 722)), /source repository lock/);
    assert.equal(git(stopped.rootPath, "rev-parse", "staging"), stopped.stagingBefore);
});
