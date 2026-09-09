// Matrix 1: spawn-time staging invariants for shape "one-submodule", state "ahead-head".
import { test } from "node:test";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree, assertAllRepoSpawned } from "./support.ts";

test("spawnStaging one-submodule ahead-head: every repo's staging, task-N ref, reset-point ref, and worktree branch land correctly", () => {
    const fixture = makeShapeFixture("one-submodule", "ahead-head", 513);
    const worktree = spawnWorktree(fixture, "run-one-sub-ahead");
    assertAllRepoSpawned(fixture, "ahead-head", worktree);
});
