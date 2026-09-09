// Matrix 4: two-submodules, ahead-head. Root's shared.txt conflicts between staging and task-N; both submodules are untouched.
import { test } from "node:test";
import assert from "node:assert";
import {
    buildFixture, spawnWorktree, commitTaskWork, commitOnStaging, merge,
    assertUntouched, repoNode, stagingTip,
} from "./support.ts";

test("mergeStaging conflictRootOnly reports a parent conflict and leaves every repo unchanged", () => {
    const fixture = buildFixture();
    const rootPath = repoNode(fixture, "root").checkoutPath;
    commitOnStaging(rootPath, "shared.txt", "line1\n");

    const spawned = spawnWorktree(fixture);
    commitTaskWork(spawned.worktree, "root", "shared.txt", "line1-from-worktree\n");
    commitOnStaging(rootPath, "shared.txt", "line1-from-main\n");
    const rootStagingBeforeMerge = stagingTip(spawned, "root");

    const report = merge(spawned);

    assert.equal(report.status, "parent-conflicted");
    if (report.status !== "parent-conflicted") return;
    assert.deepEqual(report.conflictedFilePaths, ["shared.txt"]);
    assert.deepEqual(report.completedLayers.map((layer) => layer.occurrenceId).sort(), ["sub-a", "sub-b"]);
    assert.deepEqual(report.completedLayers.map((layer) => layer.status), ["no-op", "no-op"]);

    assert.equal(stagingTip(spawned, "root"), rootStagingBeforeMerge);
    assertUntouched(spawned, "sub-a");
    assertUntouched(spawned, "sub-b");
});
