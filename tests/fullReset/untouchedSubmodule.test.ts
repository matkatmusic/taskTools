// An untouched sibling submodule never gets a merge commit, but its task refs still land and clear on reset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resetTask } from "../../scripts/tackle-tasks/resetTask.ts";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { commitWorktreeWork, git, mergeAndClose, mergedCommitsRef, refPresent, resetPointRef, spawnTask, taskBranchRef } from "./support.ts";

test("test_fullReset_untouchedSubmodule_clearsSubBsRefsWithoutAMergeCommitOnItsStaging", async () => {
    const taskNumber = 824;
    const fixture = makeShapeFixture("two-submodules-nested", "at-head", taskNumber);
    const { worktree } = spawnTask(fixture.rootPath, taskNumber, "run-1");
    // Only root and sub-a change; sub-b and the nested submodule stay untouched.
    commitWorktreeWork(worktree, ["sub-a"]);

    const subBPath = join(fixture.rootPath, "sub-b");
    const subBStagingBeforeMerge = git(subBPath, "rev-parse", "staging");

    mergeAndClose(fixture.rootPath, taskNumber, worktree);

    assert.equal(git(subBPath, "rev-parse", "staging"), subBStagingBeforeMerge);

    const cwd = process.cwd();
    try {
        process.chdir(fixture.rootPath);
        await resetTask(taskNumber, "");
    } finally {
        process.chdir(cwd);
    }

    assert.equal(git(subBPath, "rev-parse", "staging"), subBStagingBeforeMerge);
    assert.equal(refPresent(subBPath, taskBranchRef(taskNumber)), false);
    assert.equal(refPresent(subBPath, resetPointRef(taskNumber)), false);
    assert.equal(refPresent(subBPath, mergedCommitsRef(taskNumber)), false);
});
