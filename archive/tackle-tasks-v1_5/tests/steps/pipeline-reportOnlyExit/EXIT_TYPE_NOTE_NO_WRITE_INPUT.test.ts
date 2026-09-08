// Behavioral checks for scripts/steps/pipeline-reportOnlyExit/EXIT_TYPE_NOTE_NO_WRITE_INPUT.ts.
// Run: node --test tests/steps/pipeline-reportOnlyExit/EXIT_TYPE_NOTE_NO_WRITE_INPUT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reportOnlyExit/EXIT_TYPE_NOTE_NO_WRITE_INPUT.ts";

test("test_exitTypeNoteNoWriteInput_carriesTheEntryPacketForward", () => {
    // Setup: the raw entry packet a report-only-exit walk starts with.
    const output = main(JSON.stringify({ exitType: "blocked", exitNote: "an open blocker remains" }));

    // Verification: the box and signal are stamped, and the packet's fields pass through unchanged.
    assert.deepEqual(output, {
        box: "EXIT_TYPE_NOTE_NO_WRITE_INPUT",
        scriptSignal: "continue",
        exitType: "blocked",
        exitNote: "an open blocker remains",
    });
});
