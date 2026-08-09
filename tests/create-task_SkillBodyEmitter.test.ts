import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { produceSkillBody } from "../scripts/create-task_SkillBodyEmitter.ts";

const scriptPath = fileURLToPath(new URL("../scripts/create-task_SkillBodyEmitter.ts", import.meta.url));

test("test_produceSkillBodyContainsTheAbsoluteWorkflowScriptPath", () => {
    const body = produceSkillBody("test task");
    assert.match(body, /(?:^|[\s"])\/[^\s"]*skills\/create-task\/createTask\.workflow\.js/);
});

test("test_produceSkillBodyContainsTheAbsoluteAgentPromptEmitterPath", () => {
    const body = produceSkillBody("test task");
    assert.match(body, /(?:^|[\s"])\/[^\s"]*scripts\/create-task_AgentPromptEmitter\.ts/);
});

test("test_produceSkillBodyLeavesNoUnexpandedPlaceholder", () => {
    const body = produceSkillBody("test task");
    assert.doesNotMatch(body, /CLAUDE_PLUGIN_ROOT/);
    assert.doesNotMatch(body, /\$ARGUMENTS/);
});

test("test_produceSkillBodyEscapesQuotesInTheTaskDescription", () => {
    const body = produceSkillBody(`a "quoted" \\ description`);
    const workflowLine = body.split("\n").find((line) => line.startsWith("WORKFLOW: "));
    assert.ok(workflowLine, "expected a WORKFLOW: line in the skill body");
    const payload = JSON.parse(workflowLine!.slice("WORKFLOW: ".length));
    assert.equal(payload.args.taskDescription, `a "quoted" \\ description`);
});

test("test_skillBodyEmitterScriptFailsWhenStdinIsEmpty", () => {
    assert.throws(() => execFileSync("node", [scriptPath], { input: "", encoding: "utf8", stdio: "pipe" }));
});

test("test_skillBodyEmitterRunsNoSubprocessAndImportsNoSiblingScript", () => {
    const source = readFileSync(scriptPath, "utf8");
    assert.doesNotMatch(source, /execFileSync/);
    assert.doesNotMatch(source, /spawn/);
    assert.doesNotMatch(source, /from "\.\//);
});
