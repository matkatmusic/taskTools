// Behavioral checks for scripts/steps/pipeline-mergeSucceededExit/STOP.ts.
// Run: node --test tests/steps/pipeline-mergeSucceededExit/STOP.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-mergeSucceededExit/STOP.ts";

test("test_STOP_endsTheWalkWithScriptSignalStop", () => {
    const input = { box: "REPORT_CLOSURE_NOTE", scriptSignal: "continue", taskNumber: 1, closureNote: "Task 1 completed." };

    const output = main(JSON.stringify(input));

    assert.equal(output.box, "STOP");
    assert.equal(output.scriptSignal, "stop");
    assert.equal(output.taskNumber, 1);
    assert.equal(output.closureNote, "Task 1 completed.");
});
