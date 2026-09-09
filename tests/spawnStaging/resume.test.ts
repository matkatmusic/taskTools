// Matrix 1: one-submodule at-head; a second createTaskWorktree call with the same args must move nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { git } from "../support/gitFixtures.ts";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree } from "./support.ts";
import { createTaskWorktree } from "../../scripts/tackle-tasks/shared/createTaskWorktree.ts";

function recordTips(repoPath: string, branch: string) {
    return {
        staging: git(repoPath, "rev-parse", "staging"),
        taskBranch: git(repoPath, "rev-parse", branch),
        resetPoint: git(repoPath, "rev-parse", `refs/taskTools/reset-point/${branch}`),
    };
}

test("spawnStaging resume: a second createTaskWorktree call with the same args moves nothing", () => {
    const fixture = makeShapeFixture("one-submodule", "at-head", 601);
    const branch = `task-${fixture.taskNumber}`;
    const runId = "run-resume";

    spawnWorktree(fixture, runId);
    const before = fixture.repos.map((repo) => ({ repo, tips: recordTips(repo.checkoutPath, branch) }));

    createTaskWorktree(fixture.taskNumber, runId, fixture.rootPath);

    for (const { repo, tips } of before) {
        assert.deepEqual(recordTips(repo.checkoutPath, branch), tips, `${repo.occurrenceId}: tips unchanged`);
    }
});
