// Run: node --test tests/steps/pipeline-rebasePreamble/FINISHED_IMPLEMENTATION_INPUT.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../../../scripts/steps/pipeline-rebasePreamble/FINISHED_IMPLEMENTATION_INPUT.ts";

test("test_finishedImplementationInput_forwardsFieldsAndStampsTheWaitClock", () => {
    const result = main(JSON.stringify({ runId: "run-a", taskNumber: 1, projectRoot: "/abs/project" }));

    assert.equal(result.box, "FINISHED_IMPLEMENTATION_INPUT");
    assert.equal(result.scriptSignal, "continue");
    assert.equal(result.runId, "run-a");
    assert.equal(result.taskNumber, 1);
    assert.equal(result.projectRoot, "/abs/project");
    assert.ok(!Number.isNaN(Date.parse(result.lockWaitStartedAt as string)), "lockWaitStartedAt is not a parseable date");
});

test("test_finishedImplementationInput_rejectsARelativeProjectRoot", () => {
    assert.throws(() => main(JSON.stringify({ runId: "run-a", taskNumber: 1, projectRoot: "relative/path" })));
});
