// Behavioral checks for scripts/tackle-tasks/reportOnlyExit/REPORT_ONLY_EXIT.ts.  Run: node --test scripts/tackle-tasks/reportOnlyExit/REPORT_ONLY_EXIT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "./REPORT_ONLY_EXIT.ts";

test("test_reportOnlyExit_reportsTheExitTypeAndNoteWithoutWritingAnything", () => {
    // Setup: the entry packet a report-only-exit walk starts with.
    const input = {
        box: "PREAMBLE_STATUS_CHECK",
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

    // Verification: the box is stamped and every packet field passes through unchanged.
    assert.deepEqual(output, {
        box: "REPORT_ONLY_EXIT",
        scriptSignal: "continue",
        taskNumber: 169,
        runId: "run-a",
        projectRoot: "/repo",
        worktree: "/repo/.worktrees/task-169",
        branch: "task-169",
        exitType: "invalid-number",
        exitNote: "not found in `.taskTools/tasks.json`",
    });
});
