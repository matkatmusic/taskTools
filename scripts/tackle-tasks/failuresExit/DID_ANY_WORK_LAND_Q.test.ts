// Behavioral checks for DID_ANY_WORK_LAND_Q.ts. Run: node --test scripts/tackle-tasks/failuresExit/DID_ANY_WORK_LAND_Q.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./DID_ANY_WORK_LAND_Q.ts";

function packet(publicationState: string) {
    return {
        taskNumber: 169, runId: "run-a", projectRoot: "/repo", worktree: "/repo/.worktrees/task-169",
        branch: "task-169", exitType: "run-failed", exitNote: "boom", publicationState,
    };
}

test("test_DID_ANY_WORK_LAND_Q_choosesWriteExitTypeAndNoteWhenNoneLanded", () => {
    const output = main(JSON.stringify(packet("NONE LANDED")));
    assert.equal(output.next, "WRITE_EXIT_TYPE_AND_NOTE");
});

test("test_DID_ANY_WORK_LAND_Q_choosesWritePublicationOutcomeWhenSomeLanded", () => {
    const output = main(JSON.stringify(packet("SOME LANDED")));
    assert.equal(output.next, "WRITE_PUBLICATION_OUTCOME");
});

test("test_DID_ANY_WORK_LAND_Q_choosesWritePublicationOutcomeWhenAllLanded", () => {
    const output = main(JSON.stringify(packet("ALL LANDED")));
    assert.equal(output.next, "WRITE_PUBLICATION_OUTCOME");
});
