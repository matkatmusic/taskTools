// Full reset of a merged-and-closed task on the "none" repo shape undoes the merge back to the reset point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resetTask } from "../../scripts/tackle-tasks/resetTask.ts";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import {
    commitWorktreeWork, git, mergeAndClose, mergedCommitsRef, refPresent, resetPointRef, spawnTask,
    submodulePathsByShape, taskBranchRef,
} from "./support.ts";

test("test_fullReset_merged_none_undoesTheMergeBackToTheRecordedResetPoint", async () => {
    const taskNumber = 811;
    const fixture = makeShapeFixture("none", "at-head", taskNumber);
    const { worktree } = spawnTask(fixture.rootPath, taskNumber, "run-1");
    commitWorktreeWork(worktree, submodulePathsByShape.none);
    mergeAndClose(fixture.rootPath, taskNumber, worktree);

    const cwd = process.cwd();
    try {
        process.chdir(fixture.rootPath);
        await resetTask(taskNumber, "");
    } finally {
        process.chdir(cwd);
    }

    for (const repo of fixture.repos) {
        assert.equal(git(repo.checkoutPath, "rev-parse", "staging"), repo.stagingTip);
        assert.equal(refPresent(repo.checkoutPath, taskBranchRef(taskNumber)), false);
        assert.equal(refPresent(repo.checkoutPath, resetPointRef(taskNumber)), false);
        assert.equal(refPresent(repo.checkoutPath, mergedCommitsRef(taskNumber)), false);
    }
    assert.equal(existsSync(worktree), false);
});
