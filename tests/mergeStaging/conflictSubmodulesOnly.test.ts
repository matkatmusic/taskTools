// Matrix 4: sub-a clean, sub-b conflicts; resolving and retrying lands sub-b and root.
import { test } from "node:test";
import assert from "node:assert";
import {
    buildFixture, spawnWorktree, commitTaskWork, commitOnStaging, resetStagingTo, merge,
    assertMerged, repoNode, stagingTip, stagingTipAt,
} from "./support.ts";

test("mergeStaging conflictSubmodulesOnly merges sub-a, stops at sub-b, then lands sub-b and root on retry without re-merging sub-a", () => {
    const fixture = buildFixture();
    const subBPath = repoNode(fixture, "sub-b").checkoutPath;
    commitOnStaging(subBPath, "shared.txt", "line1\n");
    const subBBaselineTip = stagingTipAt(subBPath);

    const spawned = spawnWorktree(fixture);
    commitTaskWork(spawned.worktree, "sub-a", "task-work.txt", "sub-a work\n");
    commitTaskWork(spawned.worktree, "sub-b", "shared.txt", "line1-from-worktree\n");
    commitOnStaging(subBPath, "shared.txt", "line1-from-main\n");
    const rootStagingBeforeMerge = stagingTip(spawned, "root");
    const subBStagingBeforeMerge = stagingTip(spawned, "sub-b");

    const firstReport = merge(spawned);

    assert.equal(firstReport.status, "submodule-conflicted");
    if (firstReport.status !== "submodule-conflicted") return;
    assert.equal(firstReport.occurrenceId, "sub-b");
    assert.deepEqual(firstReport.conflictedFilePaths, ["shared.txt"]);
    assert.deepEqual(firstReport.completedLayers.map((layer) => layer.occurrenceId), ["sub-a"]);
    assert.equal(firstReport.completedLayers[0].status, "merged");

    // Root hasn't run gitlink-propagation yet (it hasn't merged, per the assert below), so sub-a's gitlink stays stale until retry.
    assertMerged(spawned, "sub-a", false);
    const subAStagingAfterFirstMerge = stagingTip(spawned, "sub-a");
    assert.equal(stagingTip(spawned, "sub-b"), subBStagingBeforeMerge);
    assert.equal(stagingTip(spawned, "root"), rootStagingBeforeMerge);

    resetStagingTo(subBPath, subBBaselineTip);

    const secondReport = merge(spawned);

    assert.equal(secondReport.status, "merged");
    assertMerged(spawned, "sub-b");
    assertMerged(spawned, "root");
    assert.equal(stagingTip(spawned, "sub-a"), subAStagingAfterFirstMerge);
});
