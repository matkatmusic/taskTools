// Matrix 1: diverged gitlink; temp worktree has no submodule checkout, so merge conflicts unless resolved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../support/gitFixtures.ts";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { assertRepoSpawned, spawnWorktree } from "./support.ts";

test("spawnStaging diverged gitlink: root records the sub's fresh staging tip", () => {
    const fixture = makeShapeFixture("one-submodule", "ahead-head", 601);
    const sub = fixture.repos.find((repo) => repo.occurrenceId !== "root")!;
    const root = fixture.repos.find((repo) => repo.occurrenceId === "root")!;

    writeFileSync(join(sub.checkoutPath, "diverge.txt"), "sub\n");
    git(sub.checkoutPath, "add", "diverge.txt");
    git(sub.checkoutPath, "commit", "-q", "-m", "diverge sub head");

    git(root.checkoutPath, "add", sub.occurrenceId);
    git(root.checkoutPath, "commit", "-q", "-m", "bump gitlink");

    writeFileSync(join(root.checkoutPath, "diverge.txt"), "root\n");
    git(root.checkoutPath, "add", "diverge.txt");
    git(root.checkoutPath, "commit", "-q", "-m", "diverge root head");

    const worktree = spawnWorktree(fixture, "run-diverged-gitlink");

    const rootStagingTip = git(root.checkoutPath, "rev-parse", "staging");
    const subStagingTip = git(sub.checkoutPath, "rev-parse", "staging");
    assert.equal(git(root.checkoutPath, "rev-parse", `staging:${sub.occurrenceId}`), subStagingTip, "root staging gitlink must match sub staging tip");

    const newHeadTip = git(root.checkoutPath, "rev-parse", "main");
    const parents = git(root.checkoutPath, "log", "-1", "--pretty=%P", rootStagingTip).split(" ").sort();
    assert.deepEqual(parents, [root.stagingTip!, newHeadTip].sort(), "root: merge parents");

    for (const repo of fixture.repos) {
        const mergedTip = git(repo.checkoutPath, "rev-parse", "staging");
        assertRepoSpawned(fixture, repo, worktree, mergedTip);
    }
});
