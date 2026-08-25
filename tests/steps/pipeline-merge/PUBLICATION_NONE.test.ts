// Behavioral checks for scripts/steps/pipeline-merge/PUBLICATION_NONE.ts.
// Run: node --test tests/steps/pipeline-merge/PUBLICATION_NONE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-merge/PUBLICATION_NONE.ts";

test("test_PUBLICATION_NONE_relaysThePacketAndSetsItsOwnBox", () => {
    const packet = { worktreePath: "/wt", rootSourceBranch: "main", taskNumber: 7, runId: "run-1", projectRoot: "/proj" };
    const result = main(JSON.stringify(packet));
    assert.deepEqual(result, { ...packet, box: "PUBLICATION_NONE", scriptSignal: "continue" });
});
