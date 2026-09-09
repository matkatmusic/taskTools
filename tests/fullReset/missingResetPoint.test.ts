// A missing reset-point ref in a nested submodule refuses the whole reset and names that submodule's path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resetTask } from "../../scripts/tackle-tasks/resetTask.ts";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { git, refPresent, resetPointRef, spawnTask, taskBranchRef } from "./support.ts";

test("test_fullReset_missingResetPoint_refusesAndNamesTheRepoMissingItsResetPointRef", async () => {
    const taskNumber = 823;
    const fixture = makeShapeFixture("two-submodules-nested", "at-head", taskNumber);
    spawnTask(fixture.rootPath, taskNumber, "run-1");

    const nestedPath = join(fixture.rootPath, "sub-a", "nested");
    git(nestedPath, "update-ref", "-d", resetPointRef(taskNumber));

    const stagingBefore = fixture.repos.map((repo) => git(repo.checkoutPath, "rev-parse", "staging"));

    const cwd = process.cwd();
    try {
        process.chdir(fixture.rootPath);
        await assert.rejects(
            () => resetTask(taskNumber, ""),
            (error: Error) => {
                assert.match(error.message, /reset it by hand/);
                assert.ok(error.message.includes(nestedPath), error.message);
                return true;
            },
        );
    } finally {
        process.chdir(cwd);
    }

    fixture.repos.forEach((repo, index) => {
        assert.equal(git(repo.checkoutPath, "rev-parse", "staging"), stagingBefore[index]);
        assert.equal(refPresent(repo.checkoutPath, taskBranchRef(taskNumber)), true);
    });
    assert.equal(refPresent(fixture.rootPath, resetPointRef(taskNumber)), true);
    assert.equal(refPresent(join(fixture.rootPath, "sub-a"), resetPointRef(taskNumber)), true);
    assert.equal(refPresent(join(fixture.rootPath, "sub-b"), resetPointRef(taskNumber)), true);
    assert.equal(refPresent(nestedPath, resetPointRef(taskNumber)), false);
});
