// Behavioral checks for scripts/tackle-tasks/runFullSuite/WHAT_IS_PUBLICATION_STATE_Q.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./WHAT_IS_PUBLICATION_STATE_Q.ts";

function packet(state: string): Record<string, unknown> {
    return {
        worktree: "/wt", taskNumber: 7, runId: "run-1", projectRoot: "/proj",
        exitType: "", exitNote: "", state, landed: [], notLanded: [], commits: [],
    };
}

test("test_WHAT_IS_PUBLICATION_STATE_Q_choosesMergeSucceededExitWhenAllLanded", () => {
    const result = main(JSON.stringify(packet("ALL LANDED")));
    assert.equal(result.next, "pipeline-mergeSucceededExit.mmd::MERGE_SUCCEEDED_EXIT");
    assert.equal(result.box, "WHAT_IS_PUBLICATION_STATE_Q");
    assert.equal(result.scriptSignal, "continue");
    assert.equal(result.exitType, "");
});

test("test_WHAT_IS_PUBLICATION_STATE_Q_choosesTheMergeAttemptGateWhenNoneLanded", () => {
    const result = main(JSON.stringify(packet("NONE LANDED")));
    assert.equal(result.next, "ARE_2_MERGE_ATTEMPTS_DONE_Q");
    assert.equal(result.exitType, "");
});

test("test_WHAT_IS_PUBLICATION_STATE_Q_exitsAsPartiallyPublishedWhenSomeLanded", () => {
    const result = main(JSON.stringify(packet("SOME LANDED")));
    assert.equal(result.next, "pipeline-failuresExit.mmd::FAILURES_EXIT");
    assert.equal(result.exitType, "partially-published");
    assert.match(String(result.exitNote), /RECOVERY ONLY/);
});
