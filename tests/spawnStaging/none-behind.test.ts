// Matrix 1: spawn-time staging invariants for shape "none", state "behind-head".
import { test } from "node:test";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree, assertAllRepoSpawned } from "./support.ts";

test("spawnStaging none behind-head: every repo's staging, task-N ref, reset-point ref, and worktree branch land correctly", () => {
    const fixture = makeShapeFixture("none", "behind-head", 502);
    const worktree = spawnWorktree(fixture, "run-none-behind");
    assertAllRepoSpawned(fixture, "behind-head", worktree);
});
