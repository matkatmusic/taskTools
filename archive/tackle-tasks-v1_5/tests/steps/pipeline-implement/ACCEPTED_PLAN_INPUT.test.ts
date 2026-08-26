// Behavioral checks for scripts/steps/pipeline-implement/ACCEPTED_PLAN_INPUT.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertMatchesTemplate } from "../../../scripts/contracts.ts";
import { main } from "../../../scripts/steps/pipeline-implement/ACCEPTED_PLAN_INPUT.ts";

const packet = {
    taskNumber: 42, projectRoot: "/abs/project", worktreePath: "/abs/project/.worktrees/task-42",
    runId: "run-1", sourceBranch: "main", typecheckCommand: "npx tsc --noEmit", maxFixRounds: 3,
};

test("test_main_forwardsThePacketWithTheBoxEnvelope", () => {
    const output = main(JSON.stringify(packet));
    assert.deepEqual(output, { box: "ACCEPTED_PLAN_INPUT", scriptSignal: "continue", ...packet });
});

test("test_main_matchesItsOwnTemplateShape", () => {
    const output = main(JSON.stringify(packet));
    assertMatchesTemplate("ACCEPTED_PLAN_INPUT", { box: "", scriptSignal: "", ...packet }, output);
});
