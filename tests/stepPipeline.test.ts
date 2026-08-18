// stepPipeline.ts drives tracePipeline.ts from keypresses; replay mode makes it testable without a terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/tackle-tasks/stepPipeline.ts", import.meta.url));

const replay = (sequence: string): string =>
    execFileSync("node", [SCRIPT, "42", "--replay", sequence], { encoding: "utf8" });

// Answers, in the order the walk asks them: planner, verdict, tests, review, lock, rebase, suite, fence, publication.
const HAPPY_PATH = "npnannynnynnnyya";

test("test_stepPipeline_walksAWholeRunAndEchoesTheSequenceBack", () => {
    const output = replay(HAPPY_PATH);
    assert.match(output, /Run start: Task Num \[42\]/);
    assert.match(output, /move task to completedTasks.json and update tasks blocked by it/);
    assert.match(output, new RegExp(`use sequence ${HAPPY_PATH} to replay`));
});

test("test_stepPipeline_exitsNonZeroOnAReplayKeyTheBoxDoesNotOffer", () => {
    assert.throws(() => replay("nq"), /status 1|Command failed/);
});
