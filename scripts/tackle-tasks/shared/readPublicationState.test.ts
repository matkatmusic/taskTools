// readPublicationState classifies the layer merge refs. Run alone: node --test tests/readPublicationState.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readPublicationState } from "./readPublicationState.ts";
import { taskBranchName } from "./createTaskWorktree.ts";
import { buildWorktreeOccurrences } from "./occurrences.ts";
import { git, makeLayeredSubmoduleFixture, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

const TASK = 4242;

// Writes the merge ref for the first `count` layers, exactly as mergeTaskWorktrees does when one lands.
function landLayers(worktreePath: string, projectRoot: string, count: number): void {
    const branch = taskBranchName(TASK);
    const occurrences = buildWorktreeOccurrences(worktreePath, projectRoot, "staging");
    for (const occurrence of occurrences.slice(0, count)) {
        const oid = git(occurrence.sourceCheckoutPath, "rev-parse", "HEAD");
        git(occurrence.sourceCheckoutPath, "update-ref", `refs/taskTools/merged-commits/${branch}`, oid);
    }
}

test("test_readPublicationState_reportsNoneLandedWhenNoLayerWroteItsMergeRef", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = makeLinkedWorktree(rootOrigin);

    const output = readPublicationState({ taskNumber: TASK, projectRoot: rootOrigin, worktreePath, rootSourceBranch: "staging" });

    assert.equal(output.state, "NONE LANDED");
    assert.equal(output.landed.length, 0);
});

test("test_readPublicationState_reportsSomeLandedWhenOneLayerLandedAndOthersDidNot", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    landLayers(worktreePath, rootOrigin, 1);

    const output = readPublicationState({ taskNumber: TASK, projectRoot: rootOrigin, worktreePath, rootSourceBranch: "staging" });

    assert.equal(output.state, "SOME LANDED");
    assert.equal(output.landed.length, 1);
    assert.ok(output.notLanded.length > 0);
});

test("test_readPublicationState_reportsAllLandedWhenEveryLayerWroteItsMergeRef", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const layerCount = buildWorktreeOccurrences(worktreePath, rootOrigin, "staging").length;
    landLayers(worktreePath, rootOrigin, layerCount);

    const output = readPublicationState({ taskNumber: TASK, projectRoot: rootOrigin, worktreePath, rootSourceBranch: "staging" });

    assert.equal(output.state, "ALL LANDED");
    assert.equal(output.notLanded.length, 0);
    assert.equal(output.landed.length, layerCount);
});
