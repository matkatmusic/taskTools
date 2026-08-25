// Behavioral checks for scripts/steps/pipeline-failuresExit/DID_ANY_WORK_LAND.ts.
// Run: node --test tests/steps/pipeline-failuresExit/DID_ANY_WORK_LAND.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-failuresExit/DID_ANY_WORK_LAND.ts";

function packet(publicationState: string) {
    return {
        taskNumber: 169, runId: "run-a", projectRoot: "/repo", worktree: "/repo/.worktrees/task-169",
        sourceBranch: "master", exitType: "run-failed", exitNote: "boom", publicationState,
    };
}

test("test_DID_ANY_WORK_LAND_choosesWriteExitTypeAndNoteWhenNoneLanded", () => {
    const output = main(JSON.stringify(packet("NONE LANDED")));
    assert.equal(output.next, "WRITE_EXIT_TYPE_AND_NOTE");
});

test("test_DID_ANY_WORK_LAND_choosesWritePublicationOutcomeWhenSomeLanded", () => {
    const output = main(JSON.stringify(packet("SOME LANDED")));
    assert.equal(output.next, "WRITE_PUBLICATION_OUTCOME");
});

test("test_DID_ANY_WORK_LAND_choosesWritePublicationOutcomeWhenAllLanded", () => {
    const output = main(JSON.stringify(packet("ALL LANDED")));
    assert.equal(output.next, "WRITE_PUBLICATION_OUTCOME");
});
