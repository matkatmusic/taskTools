// Behavioral checks for scripts/steps/pipeline-reportOnlyExit/STOP.ts.
// Run: node --test tests/steps/pipeline-reportOnlyExit/STOP.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reportOnlyExit/STOP.ts";

test("test_stop_endsTheWalkWithScriptSignalStop", () => {
    // Setup: the reported exit type and exitNote, ready for the walk to end.
    const input = { box: "REPORT_EXIT_TYPE_NO_WRITE", scriptSignal: "continue", exitType: "invalid-number", exitNote: "not found in `.taskTools/tasks.json`" };

    const output = main(JSON.stringify(input));

    // Verification: the walk ends here, carrying the exit type and exitNote as the final payload.
    assert.deepEqual(output, {
        box: "STOP",
        scriptSignal: "stop",
        exitType: "invalid-number",
        exitNote: "not found in `.taskTools/tasks.json`",
    });
});
