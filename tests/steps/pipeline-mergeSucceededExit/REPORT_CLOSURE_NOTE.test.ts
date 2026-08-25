// Behavioral checks for scripts/steps/pipeline-mergeSucceededExit/REPORT_CLOSURE_NOTE.ts.
// Run: node --test tests/steps/pipeline-mergeSucceededExit/REPORT_CLOSURE_NOTE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-mergeSucceededExit/REPORT_CLOSURE_NOTE.ts";

test("test_REPORT_CLOSURE_NOTE_reportsTheClosureNoteUnchanged", () => {
    const input = { box: "ARCHIVE_TASK", scriptSignal: "continue", taskNumber: 1, closureNote: "Task 1 completed." };

    const output = main(JSON.stringify(input));

    assert.equal(output.box, "REPORT_CLOSURE_NOTE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.taskNumber, 1);
    assert.equal(output.closureNote, "Task 1 completed.");
});
