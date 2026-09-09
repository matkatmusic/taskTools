// Matrix 4: two-submodules, ahead-head. Task-N touches only root; both submodules stay untouched.
import { test } from "node:test";
import assert from "node:assert";
import { buildFixture, spawnWorktree, commitTaskWork, merge, assertMerged, assertUntouched } from "./support.ts";

test("mergeStaging noConflictRoot merges only the root layer", () => {
    const fixture = buildFixture();
    const spawned = spawnWorktree(fixture);
    commitTaskWork(spawned.worktree, "root", "task-work.txt", "root work\n");

    const report = merge(spawned);

    assert.equal(report.status, "merged");
    assertMerged(spawned, "root");
    assertUntouched(spawned, "sub-a");
    assertUntouched(spawned, "sub-b");
});
