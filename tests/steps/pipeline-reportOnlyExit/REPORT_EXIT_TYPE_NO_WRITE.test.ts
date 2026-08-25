// Behavioral checks for scripts/steps/pipeline-reportOnlyExit/REPORT_EXIT_TYPE_NO_WRITE.ts.
// Run: node --test tests/steps/pipeline-reportOnlyExit/REPORT_EXIT_TYPE_NO_WRITE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-reportOnlyExit/REPORT_EXIT_TYPE_NO_WRITE.ts";

test("test_reportExitTypeNoWrite_reportsTheExitTypeAndNoteWithoutWritingAnything", () => {
    // Setup: the previous box's output, holding the exit type and exitNote.
    const input = { box: "EXIT_TYPE_NOTE_NO_WRITE_INPUT", scriptSignal: "continue", exitType: "already-active", exitNote: "a previous run left the task active" };

    const output = main(JSON.stringify(input));

    // Verification: the exit type and exitNote are reported forward, exactly as the old SkillBodyEmitter said them.
    assert.deepEqual(output, {
        box: "REPORT_EXIT_TYPE_NO_WRITE",
        scriptSignal: "continue",
        exitType: "already-active",
        exitNote: "a previous run left the task active",
    });
});
