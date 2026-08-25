// Behavioral checks for scripts/steps/pipeline-merge/WHAT_IS_PUBLICATION_STATE.ts.
// Run: node --test tests/steps/pipeline-merge/WHAT_IS_PUBLICATION_STATE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-merge/WHAT_IS_PUBLICATION_STATE.ts";

function packet(state: string): Record<string, unknown> {
    return { worktreePath: "/wt", rootSourceBranch: "main", taskNumber: 7, runId: "run-1", projectRoot: "/proj", state, landed: [], notLanded: [], commits: [] };
}

test("test_WHAT_IS_PUBLICATION_STATE_choosesPublicationAllWhenAllLanded", () => {
    const result = main(JSON.stringify(packet("ALL LANDED")));
    assert.equal(result.next, "PUBLICATION_ALL");
    assert.equal(result.box, "WHAT_IS_PUBLICATION_STATE");
    assert.equal(result.scriptSignal, "continue");
});

test("test_WHAT_IS_PUBLICATION_STATE_choosesPublicationNoneWhenNoneLanded", () => {
    const result = main(JSON.stringify(packet("NONE LANDED")));
    assert.equal(result.next, "PUBLICATION_NONE");
});

test("test_WHAT_IS_PUBLICATION_STATE_choosesPublicationPartialWhenSomeLanded", () => {
    const result = main(JSON.stringify(packet("SOME LANDED")));
    assert.equal(result.next, "PUBLICATION_PARTIAL");
});
