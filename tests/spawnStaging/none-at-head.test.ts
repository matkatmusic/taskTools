// Matrix 1: spawn-time staging invariants for shape "none", state "at-head".
import { test } from "node:test";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree, assertAllRepoSpawned } from "./support.ts";

test("spawnStaging none at-head: every repo's staging, task-N ref, reset-point ref, and worktree branch land correctly", () => {
    const fixture = makeShapeFixture("none", "at-head", 501);
    const worktree = spawnWorktree(fixture, "run-none-at-head");
    assertAllRepoSpawned(fixture, "at-head", worktree);
});
