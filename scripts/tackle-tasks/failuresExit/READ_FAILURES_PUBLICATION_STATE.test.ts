// Behavioral checks for READ_FAILURES_PUBLICATION_STATE.ts. Ported from tests/readPublicationState.test.ts.  Run: node --test scripts/tackle-tasks/failuresExit/READ_FAILURES_PUBLICATION_STATE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./READ_FAILURES_PUBLICATION_STATE.ts";
import { taskBranchName } from "../shared/createTaskWorktree.ts";
import { buildWorktreeOccurrences } from "../shared/occurrences.ts";
import { git, makeLayeredSubmoduleFixture, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

const TASK = 4242;

function packet(rootOrigin: string, worktreePath: string) {
    return JSON.stringify({
        box: "FAILURES_EXIT", scriptSignal: "continue", taskNumber: TASK, runId: "run-a",
        projectRoot: rootOrigin, worktree: worktreePath, branch: taskBranchName(TASK),
        exitType: "run-failed", exitNote: "boom",
    });
}

// Writes the merge ref for the first `count` layers, exactly as mergeTaskWorktrees does when one lands.
function landLayers(worktreePath: string, projectRoot: string, count: number): void {
    const branch = taskBranchName(TASK);
    const occurrences = buildWorktreeOccurrences(worktreePath, projectRoot, "staging");
    for (const occurrence of occurrences.slice(0, count)) {
        const oid = git(occurrence.sourceCheckoutPath, "rev-parse", "HEAD");
        git(occurrence.sourceCheckoutPath, "update-ref", `refs/taskTools/merged-commits/${branch}`, oid);
    }
}

test("test_READ_FAILURES_PUBLICATION_STATE_reportsNoneLandedWhenNoLayerWroteItsMergeRef", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = makeLinkedWorktree(rootOrigin);

    const output = main(packet(rootOrigin, worktreePath));

    assert.equal(output.publicationState, "NONE LANDED");
});

test("test_READ_FAILURES_PUBLICATION_STATE_reportsSomeLandedWhenOneLayerLandedAndOthersDidNot", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    landLayers(worktreePath, rootOrigin, 1);

    const output = main(packet(rootOrigin, worktreePath));

    assert.equal(output.publicationState, "SOME LANDED");
});

test("test_READ_FAILURES_PUBLICATION_STATE_reportsAllLandedWhenEveryLayerWroteItsMergeRef", () => {
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const worktreePath = makeLinkedWorktree(rootOrigin);
    const layerCount = buildWorktreeOccurrences(worktreePath, rootOrigin, "staging").length;
    landLayers(worktreePath, rootOrigin, layerCount);

    const output = main(packet(rootOrigin, worktreePath));

    assert.equal(output.publicationState, "ALL LANDED");
});
