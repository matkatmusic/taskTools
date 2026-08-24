// REPORT_ONLY_EXIT.ts is the hand-off into pipeline-reportOnlyExit.mmd.
// Run alone: node --test tests/steps/pipeline-preambleStatusCheck/REPORT_ONLY_EXIT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-preambleStatusCheck/REPORT_ONLY_EXIT.ts";

test("test_REPORT_ONLY_EXIT_forwardsExitTypeAndNote", () => {
    const output = main(JSON.stringify({
        box: "IS_TASK_ACTIVE", scriptSignal: "continue", next: "REPORT_ONLY_EXIT",
        taskNumber: 1, tasksFile: "/tmp/tasks.json", exitType: "already-active", note: "a previous run left the task active",
    }));
    assert.deepEqual(output, {
        box: "REPORT_ONLY_EXIT", scriptSignal: "continue", exitType: "already-active", note: "a previous run left the task active",
    });
});
