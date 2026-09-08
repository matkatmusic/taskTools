// Behavioral checks for scripts/steps/pipeline-failuresExit/STOP.ts.
// Run: node --test tests/steps/pipeline-failuresExit/STOP.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-failuresExit/STOP.ts";

test("test_STOP_endsTheWalkWithScriptSignalStop", () => {
    const packet = {
        taskNumber: 169, runId: "run-a", projectRoot: "/repo", worktree: "/repo/.worktrees/task-169",
        sourceBranch: "master", exitType: "run-failed", exitNote: "boom",
        publicationState: "NONE LANDED", modifiedFiles: [], leaseReleased: true, leaseRetained: false,
        lockReleased: true, active: false, endedAt: "2026-08-23T12:00:00-07:00",
    };

    const output = main(JSON.stringify(packet));

    assert.equal(output.box, "STOP");
    assert.equal(output.scriptSignal, "stop");
});
