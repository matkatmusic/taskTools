// Behavioral checks for scripts/steps/pipeline-failuresExit/REPORT_EXIT_TYPE_AND_NOTE.ts.  Run: node --test tests/steps/pipeline-failuresExit/REPORT_EXIT_TYPE_AND_NOTE.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-failuresExit/REPORT_EXIT_TYPE_AND_NOTE.ts";

test("test_REPORT_EXIT_TYPE_AND_NOTE_reportsTheRunsExitTypeAndNote", () => {
    const packet = {
        taskNumber: 169, runId: "run-a", projectRoot: "/repo", worktree: "/repo/.worktrees/task-169",
        sourceBranch: "master", exitType: "partially-published", exitNote: "boom",
        publicationState: "SOME LANDED", modifiedFiles: [], next: "REPORT_EXIT_TYPE_AND_NOTE",
        leaseReleased: true, leaseRetained: false,
        lockReleased: true, active: false, endedAt: "2026-08-23T12:00:00-07:00",
    };

    const output = main(JSON.stringify(packet));

    assert.equal(output.box, "REPORT_EXIT_TYPE_AND_NOTE");
    assert.equal(output.scriptSignal, "continue");
    assert.equal(output.exitType, "partially-published");
    assert.equal(output.exitNote, "boom");
});
