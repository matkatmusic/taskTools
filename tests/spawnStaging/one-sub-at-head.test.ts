// Matrix 1: spawn-time staging invariants for shape "one-submodule", state "at-head".
import { test } from "node:test";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree, assertAllRepoSpawned } from "./support.ts";

test("spawnStaging one-submodule at-head: every repo's staging, task-N ref, reset-point ref, and worktree branch land correctly", () => {
    const fixture = makeShapeFixture("one-submodule", "at-head", 511);
    const worktree = spawnWorktree(fixture, "run-one-sub-at-head");
    assertAllRepoSpawned(fixture, "at-head", worktree);
});
