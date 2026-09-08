// Behavioral checks for scripts/steps/pipeline-merge/READ_MERGE_PUBLICATION_STATE.ts, ported from
// tests/readPublicationState.test.ts. Read-only: exercised against real temp git fixtures, never
// real project state. Run: node --test tests/steps/pipeline-merge/READ_MERGE_PUBLICATION_STATE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-merge/READ_MERGE_PUBLICATION_STATE.ts";
import { taskBranchName } from "../../../scripts/tackle-tasks/createTaskWorktree.ts";
import { buildWorktreeOccurrences } from "../../../scripts/tackle-tasks/occurrences.ts";
import { git, makeLayeredSubmoduleFixture, makeLinkedWorktree } from "../../support/gitFixtures.ts";

const TASK = 4242;

function packet(worktreePath: string, projectRoot: string): string {
    return JSON.stringify({
        worktreePath, rootSourceBranch: "main", taskNumber: TASK, runId: "run-1", projectRoot,
    });
}

// Writes the merge ref for the first `count` layers, exactly as mergeTaskWorktrees does when one lands.
function landLayers(worktreePath: string, projectRoot: string, count: number): void {
    const branch = taskBranchName(TASK);
    const occurrences = buildWorktreeOccurrences(worktreePath, projectRoot);
    for (const occurrence of occurrences.slice(0, count)) {
        const oid = git(occurrence.sourceCheckoutPath, "rev-parse", "HEAD");
        git(occurrence.sourceCheckoutPath, "update-ref", `refs/taskTools/merged-commits/${branch}`, oid);
    }
}

test("test_READ_MERGE_PUBLICATION_STATE_reportsNoneLandedWhenNoLayerWroteItsMergeRef", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = makeLinkedWorktree(rootOrigin);

    const result = main(packet(worktreePath, rootOrigin));

    assert.equal(result.box, "READ_MERGE_PUBLICATION_STATE");
    assert.equal(result.state, "NONE LANDED");
    assert.equal((result.landed as string[]).length, 0);
});

test("test_READ_MERGE_PUBLICATION_STATE_reportsSomeLandedWhenOneLayerLandedAndOthersDidNot", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    landLayers(worktreePath, rootOrigin, 1);

    const result = main(packet(worktreePath, rootOrigin));

    assert.equal(result.state, "SOME LANDED");
    assert.equal((result.landed as string[]).length, 1);
    assert.ok((result.notLanded as string[]).length > 0);
});

test("test_READ_MERGE_PUBLICATION_STATE_reportsAllLandedWhenEveryLayerWroteItsMergeRef", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const layerCount = buildWorktreeOccurrences(worktreePath, rootOrigin).length;
    landLayers(worktreePath, rootOrigin, layerCount);

    const result = main(packet(worktreePath, rootOrigin));

    assert.equal(result.state, "ALL LANDED");
    assert.equal((result.notLanded as string[]).length, 0);
    assert.equal((result.landed as string[]).length, layerCount);
});
