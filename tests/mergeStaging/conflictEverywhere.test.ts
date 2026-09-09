// Matrix 4: shared.txt conflicts everywhere; the walk stops at the first submodule conflict.
import { test } from "node:test";
import assert from "node:assert";
import {
    buildFixture, spawnWorktree, commitTaskWork, commitOnStaging, merge,
    repoNode, stagingTip, refPresent, mergedCommitsRef,
} from "./support.ts";

test("mergeStaging conflictEverywhere stops at the first submodule conflict and touches nothing", () => {
    const fixture = buildFixture();
    const rootPath = repoNode(fixture, "root").checkoutPath;
    const subAPath = repoNode(fixture, "sub-a").checkoutPath;
    const subBPath = repoNode(fixture, "sub-b").checkoutPath;
    commitOnStaging(rootPath, "shared.txt", "line1\n");
    commitOnStaging(subAPath, "shared.txt", "line1\n");
    commitOnStaging(subBPath, "shared.txt", "line1\n");

    const spawned = spawnWorktree(fixture);
    commitTaskWork(spawned.worktree, "root", "shared.txt", "line1-from-worktree\n");
    commitTaskWork(spawned.worktree, "sub-a", "shared.txt", "line1-from-worktree\n");
    commitTaskWork(spawned.worktree, "sub-b", "shared.txt", "line1-from-worktree\n");
    commitOnStaging(rootPath, "shared.txt", "line1-from-main\n");
    commitOnStaging(subAPath, "shared.txt", "line1-from-main\n");
    commitOnStaging(subBPath, "shared.txt", "line1-from-main\n");
    const rootStagingBeforeMerge = stagingTip(spawned, "root");
    const subAStagingBeforeMerge = stagingTip(spawned, "sub-a");
    const subBStagingBeforeMerge = stagingTip(spawned, "sub-b");

    const report = merge(spawned);

    assert.equal(report.status, "submodule-conflicted");
    if (report.status !== "submodule-conflicted") return;
    assert.equal(report.occurrenceId, "sub-a");
    assert.deepEqual(report.conflictedFilePaths, ["shared.txt"]);
    assert.deepEqual(report.completedLayers, []);

    assert.equal(stagingTip(spawned, "root"), rootStagingBeforeMerge);
    assert.equal(stagingTip(spawned, "sub-a"), subAStagingBeforeMerge);
    assert.equal(stagingTip(spawned, "sub-b"), subBStagingBeforeMerge);
    assert.equal(refPresent(rootPath, mergedCommitsRef()), false);
    assert.equal(refPresent(subAPath, mergedCommitsRef()), false);
    assert.equal(refPresent(subBPath, mergedCommitsRef()), false);
});
