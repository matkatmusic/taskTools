// stepPipeline.ts drives tracePipeline.ts from keypresses. Replay mode makes that testable without a terminal: the same sequence must always produce the same trace, and echo itself back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/tackle-tasks/stepPipeline.ts", import.meta.url));

const replay = (sequence: string): string =>
    execFileSync("node", [SCRIPT, "42", "--replay", sequence], { encoding: "utf8" });

// Answers, in the order the walk asks them: valid, unblocked, inactive, no worktree, then agents.
const HAPPY_PATH = "ynnnrrarnrnyyofyyy";

test("test_stepPipeline_walksAWholeRunAndEchoesTheSequenceBack", () => {
    const output = replay(HAPPY_PATH);
    assert.match(output, /Run start: Task Num \[42\]/);
    assert.match(output, /move task to completedTasks.json and update tasks blocked by it/);
    assert.match(output, new RegExp(`use sequence ${HAPPY_PATH} to replay`));
});

test("test_stepPipeline_retriesAnAgentBoxWhoseResultTheHarnessLost", () => {
    const output = replay("ynnn0rrarnrnyyofyyy");
    assert.match(output, /<-- AGENT --> plan the task\ndid the agent return a result\?: NO\nretry the box\n<-- AGENT --> plan the task/);
});

test("test_stepPipeline_exitsNonZeroOnAReplayKeyTheBoxDoesNotOffer", () => {
    assert.throws(() => replay("yq"), /status 1|Command failed/);
});
