// Matrix 1: spawn-time staging invariants for shape "one-submodule", state "behind-head".
import { test } from "node:test";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree, assertAllRepoSpawned } from "./support.ts";

test("spawnStaging one-submodule behind-head: every repo's staging, task-N ref, reset-point ref, and worktree branch land correctly", () => {
    const fixture = makeShapeFixture("one-submodule", "behind-head", 512);
    const worktree = spawnWorktree(fixture, "run-one-sub-behind");
    assertAllRepoSpawned(fixture, "behind-head", worktree);
});
