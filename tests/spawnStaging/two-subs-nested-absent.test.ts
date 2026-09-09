// Matrix 1: spawn-time staging invariants for shape "two-submodules-nested", state "absent".
import { test } from "node:test";
import { makeShapeFixture } from "../support/repoShapeFixtures.ts";
import { spawnWorktree, assertAllRepoSpawned } from "./support.ts";

test("spawnStaging two-submodules-nested absent: every repo's staging, task-N ref, reset-point ref, and worktree branch land correctly", () => {
    const fixture = makeShapeFixture("two-submodules-nested", "absent", 530);
    const worktree = spawnWorktree(fixture, "run-two-subs-nested-absent");
    assertAllRepoSpawned(fixture, "absent", worktree);
});
