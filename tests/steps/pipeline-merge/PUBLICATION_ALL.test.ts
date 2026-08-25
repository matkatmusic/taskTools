// Behavioral checks for scripts/steps/pipeline-merge/PUBLICATION_ALL.ts.
// Run: node --test tests/steps/pipeline-merge/PUBLICATION_ALL.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-merge/PUBLICATION_ALL.ts";

test("test_PUBLICATION_ALL_relaysThePacketAndSetsItsOwnBox", () => {
    const packet = { worktreePath: "/wt", taskNumber: 7, runId: "run-1", projectRoot: "/proj", commits: [] };
    const result = main(JSON.stringify(packet));
    assert.deepEqual(result, { ...packet, box: "PUBLICATION_ALL", scriptSignal: "continue" });
});
