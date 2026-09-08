// Behavioral checks for FAILURES_EXIT.ts. Run: node --test scripts/tackle-tasks/failuresExit/FAILURES_EXIT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./FAILURES_EXIT.ts";

function packet() {
    return {
        taskNumber: 169, runId: "run-a", projectRoot: "/repo", worktree: "/repo/.worktrees/task-169",
        branch: "task-169", exitType: "run-failed", exitNote: "boom",
    };
}

test("test_FAILURES_EXIT_forwardsTheIncomingPacketWithTheBoxAndSignalAdded", () => {
    const output = main(JSON.stringify(packet()));

    assert.deepEqual(output, { ...packet(), box: "FAILURES_EXIT", scriptSignal: "continue" });
});

test("test_FAILURES_EXIT_overridesTheIncomingBoxWithItsOwn", () => {
    const input = { box: "WHAT_IS_REVIEW_VERDICT", scriptSignal: "continue", ...packet() };

    const output = main(JSON.stringify(input));

    assert.equal(output.box, "FAILURES_EXIT");
});
