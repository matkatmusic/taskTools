// Matrix 1: spawn-time staging invariants for shape "one-submodule", state "absent".
import { test } from "node:test";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree, assertAllRepoSpawned } from "./support.ts";

test("spawnStaging one-submodule absent: every repo's staging, task-N ref, reset-point ref, and worktree branch land correctly", () => {
    const fixture = makeShapeFixture("one-submodule", "absent", 510);
    const worktree = spawnWorktree(fixture, "run-one-sub-absent");
    assertAllRepoSpawned(fixture, "absent", worktree);
});
