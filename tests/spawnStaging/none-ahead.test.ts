// Matrix 1: spawn-time staging invariants for shape "none", state "ahead-head".
import { test } from "node:test";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree, assertAllRepoSpawned } from "./support.ts";

test("spawnStaging none ahead-head: every repo's staging, task-N ref, reset-point ref, and worktree branch land correctly", () => {
    const fixture = makeShapeFixture("none", "ahead-head", 503);
    const worktree = spawnWorktree(fixture, "run-none-ahead");
    assertAllRepoSpawned(fixture, "ahead-head", worktree);
});
