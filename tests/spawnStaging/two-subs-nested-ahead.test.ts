// Matrix 1: spawn-time staging invariants for shape "two-submodules-nested", state "ahead-head".
import { test } from "node:test";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree, assertAllRepoSpawned } from "./support.ts";

test("spawnStaging two-submodules-nested ahead-head: every repo's staging, task-N ref, reset-point ref, and worktree branch land correctly", () => {
    const fixture = makeShapeFixture("two-submodules-nested", "ahead-head", 533);
    const worktree = spawnWorktree(fixture, "run-two-subs-nested-ahead");
    assertAllRepoSpawned(fixture, "ahead-head", worktree);
});
