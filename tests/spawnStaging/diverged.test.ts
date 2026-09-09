// Matrix 1: one-submodule ahead-head plus a new HEAD commit; staging must merge the old tip with the new HEAD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../support/gitFixtures.ts";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { assertRepoSpawned, spawnWorktree } from "./support.ts";

test("spawnStaging diverged: staging becomes a merge of the old staging tip and the new HEAD", () => {
    const fixture = makeShapeFixture("one-submodule", "ahead-head", 600);
    for (const repo of fixture.repos) {
        writeFileSync(join(repo.checkoutPath, "diverge.txt"), `${repo.occurrenceId}\n`);
        git(repo.checkoutPath, "add", "diverge.txt");
        git(repo.checkoutPath, "commit", "-q", "-m", "diverge head past staging");
    }

    const worktree = spawnWorktree(fixture, "run-diverged");

    for (const repo of fixture.repos) {
        const mergedTip = git(repo.checkoutPath, "rev-parse", "staging");
        const newHeadTip = git(repo.checkoutPath, "rev-parse", "main");
        const parents = git(repo.checkoutPath, "log", "-1", "--pretty=%P", mergedTip).split(" ").sort();
        assert.deepEqual(parents, [repo.stagingTip!, newHeadTip].sort(), `${repo.occurrenceId}: merge parents`);
        assertRepoSpawned(fixture, repo, worktree, mergedTip);
    }
});
