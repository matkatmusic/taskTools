// Matrix 1: spawn-time staging invariants for shape "two-submodules", state "behind-head".
import { test } from "node:test";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree, assertAllRepoSpawned } from "./support.ts";

test("spawnStaging two-submodules behind-head: every repo's staging, task-N ref, reset-point ref, and worktree branch land correctly", () => {
    const fixture = makeShapeFixture("two-submodules", "behind-head", 522);
    const worktree = spawnWorktree(fixture, "run-two-subs-behind");
    assertAllRepoSpawned(fixture, "behind-head", worktree);
});
