// Matrix 1: spawn-time staging invariants for shape "none", state "absent".
import { test } from "node:test";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree, assertAllRepoSpawned } from "./support.ts";

test("spawnStaging none absent: every repo's staging, task-N ref, reset-point ref, and worktree branch land correctly", () => {
    const fixture = makeShapeFixture("none", "absent", 500);
    const worktree = spawnWorktree(fixture, "run-none-absent");
    assertAllRepoSpawned(fixture, "absent", worktree);
});
