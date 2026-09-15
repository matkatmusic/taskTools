// An open task's full reset only wipes local state, so a missing ref in a submodule blocks nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resetTask } from "../../scripts/tackle-tasks/resetTask.ts";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { git, refPresent, resetPointRef, spawnTask, taskBranchRef } from "./support.ts";

test("test_fullReset_missingResetPoint_openTaskSucceedsAndClearsEveryRepo", async () => {
    const taskNumber = 823;
    const fixture = makeShapeFixture("two-submodules-nested", "at-head", taskNumber);
    const { worktree } = spawnTask(fixture.rootPath, taskNumber, "run-1");

    const nestedPath = join(fixture.rootPath, "sub-a", "nested");
    git(nestedPath, "update-ref", "-d", resetPointRef(taskNumber));

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
