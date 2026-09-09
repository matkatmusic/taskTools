// Full reset of a spawned-but-never-merged task on the "two-submodules-nested" repo shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resetTask } from "../../scripts/tackle-tasks/resetTask.ts";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { git, refPresent, resetPointRef, spawnTask, taskBranchRef } from "./support.ts";

test("test_fullReset_open_twoSubmodulesNested_removesTheSpawnFromEveryRepoWithoutTouchingStaging", async () => {
    const taskNumber = 804;
    const fixture = makeShapeFixture("two-submodules-nested", "at-head", taskNumber);
    const { worktree } = spawnTask(fixture.rootPath, taskNumber, "run-1");

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
    }
    assert.equal(existsSync(worktree), false);
});
