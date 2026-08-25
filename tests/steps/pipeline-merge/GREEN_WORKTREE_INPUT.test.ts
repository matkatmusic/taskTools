// Behavioral checks for scripts/steps/pipeline-merge/GREEN_WORKTREE_INPUT.ts.
// Run: node --test tests/steps/pipeline-merge/GREEN_WORKTREE_INPUT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-merge/GREEN_WORKTREE_INPUT.ts";

test("test_GREEN_WORKTREE_INPUT_relaysThePacketAndAddsBoxAndScriptSignal", () => {
    const packet = { worktreePath: "/wt", rootSourceBranch: "main", taskNumber: 7, runId: "run-1", projectRoot: "/proj" };
    const result = main(JSON.stringify(packet));
    assert.deepEqual(result, { ...packet, box: "GREEN_WORKTREE_INPUT", scriptSignal: "continue" });
});
