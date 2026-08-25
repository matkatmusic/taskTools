// Behavioral checks for scripts/steps/pipeline-merge/EXIT_WORKFLOW_MERGE.ts.
// Run: node --test tests/steps/pipeline-merge/EXIT_WORKFLOW_MERGE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-merge/EXIT_WORKFLOW_MERGE.ts";

test("test_EXIT_WORKFLOW_MERGE_relaysThePacketAndSetsItsOwnBox", () => {
    const packet = { worktreePath: "/wt", taskNumber: 7, runId: "run-1", projectRoot: "/proj", exitType: "merge-failed", exitNote: "note" };
    const result = main(JSON.stringify(packet));
    assert.deepEqual(result, { ...packet, box: "EXIT_WORKFLOW_MERGE", scriptSignal: "continue" });
});
