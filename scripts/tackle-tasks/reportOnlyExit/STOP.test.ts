// Behavioral checks for scripts/tackle-tasks/reportOnlyExit/STOP.ts. Run: node --test scripts/tackle-tasks/reportOnlyExit/STOP.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./STOP.ts";

test("test_stop_endsTheWalkWithScriptSignalStop", () => {
    // Setup: the reported exit type and exitNote, ready for the walk to end.
    const input = {
        box: "REPORT_ONLY_EXIT",
        scriptSignal: "continue",
        taskNumber: 169,
        runId: "run-a",
        projectRoot: "/repo",
        worktree: "/repo/.worktrees/task-169",
        branch: "task-169",
        exitType: "invalid-number",
        exitNote: "not found in `.taskTools/tasks.json`",
    };

    const output = main(JSON.stringify(input));

    // Verification: the walk ends here, carrying the whole packet as the final payload.
    assert.deepEqual(output, { ...input, box: "STOP", scriptSignal: "stop" });
});

test("test_stop_endsTheWalkWithOnlyTheKeysAllThreeSendersGive", () => {
    const output = main(JSON.stringify({ box: "REPORT_CLOSURE_NOTE", scriptSignal: "continue", taskNumber: 42 }));
    assert.deepEqual(output, { box: "STOP", scriptSignal: "stop", taskNumber: 42 });
});
