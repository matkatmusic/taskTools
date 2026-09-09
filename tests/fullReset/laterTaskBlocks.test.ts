// Resetting an earlier merged task refuses while a later task's merge sits on top, naming the blocker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetTask } from "../../scripts/tackle-tasks/resetTask.ts";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { commitWorktreeWork, git, mergeAndClose, spawnTask, submodulePathsByShape } from "./support.ts";

test("test_fullReset_laterTaskBlocks_refusesResetOfAnEarlierMergedTaskAndNamesTheBlockingTask", async () => {
    const taskN = 821;
    const taskNPlus1 = 822;
    const fixture = makeShapeFixture("two-submodules-nested", "at-head", taskN);
    const subPaths = submodulePathsByShape["two-submodules-nested"];

    const spawnN = spawnTask(fixture.rootPath, taskN, "run-n");
    commitWorktreeWork(spawnN.worktree, subPaths);
    mergeAndClose(fixture.rootPath, taskN, spawnN.worktree);

    const spawnNPlus1 = spawnTask(fixture.rootPath, taskNPlus1, "run-n1");
    commitWorktreeWork(spawnNPlus1.worktree, subPaths);
    mergeAndClose(fixture.rootPath, taskNPlus1, spawnNPlus1.worktree);

    const stagingBeforeReset = fixture.repos.map((repo) => git(repo.checkoutPath, "rev-parse", "staging"));

    const cwd = process.cwd();
    try {
        process.chdir(fixture.rootPath);
        await assert.rejects(
            () => resetTask(taskN, ""),
            (error: Error) => {
                assert.match(error.message, /blocked/);
                assert.match(error.message, new RegExp(String(taskNPlus1)));
                return true;
            },
        );
    } finally {
        process.chdir(cwd);
    }

    fixture.repos.forEach((repo, index) => {
        assert.equal(git(repo.checkoutPath, "rev-parse", "staging"), stagingBeforeReset[index]);
    });
});
