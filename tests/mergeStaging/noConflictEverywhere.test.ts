// Matrix 4: two-submodules, ahead-head. Task-N touches root and both submodules; every layer merges.
import { test } from "node:test";
import assert from "node:assert";
import { buildFixture, spawnWorktree, commitTaskWork, merge, assertMerged } from "./support.ts";

test("mergeStaging noConflictEverywhere merges root and both submodules", () => {
    const fixture = buildFixture();
    const spawned = spawnWorktree(fixture);
    commitTaskWork(spawned.worktree, "sub-a", "task-work.txt", "sub-a work\n");
    commitTaskWork(spawned.worktree, "sub-b", "task-work.txt", "sub-b work\n");
    commitTaskWork(spawned.worktree, "root", "task-work.txt", "root work\n");

    const report = merge(spawned);

    assert.equal(report.status, "merged");
    assertMerged(spawned, "sub-a");
    assertMerged(spawned, "sub-b");
    assertMerged(spawned, "root");
});
