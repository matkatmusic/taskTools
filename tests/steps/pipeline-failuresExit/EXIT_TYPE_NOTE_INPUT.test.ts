// Behavioral checks for scripts/steps/pipeline-failuresExit/EXIT_TYPE_NOTE_INPUT.ts.
// Run: node --test tests/steps/pipeline-failuresExit/EXIT_TYPE_NOTE_INPUT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-failuresExit/EXIT_TYPE_NOTE_INPUT.ts";

test("test_EXIT_TYPE_NOTE_INPUT_forwardsTheIncomingPacketWithTheBoxAndSignalAdded", () => {
    const packet = {
        taskNumber: 169, runId: "run-a", projectRoot: "/repo", worktree: "/repo/.worktrees/task-169",
        sourceBranch: "master", exitType: "run-failed", exitNote: "boom",
    };

    const output = main(JSON.stringify(packet));

    assert.deepEqual(output, { ...packet, box: "EXIT_TYPE_NOTE_INPUT", scriptSignal: "continue" });
});
