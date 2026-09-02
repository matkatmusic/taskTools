import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    produceFileHunterPrompt,
    produceBlockerHunterPrompt,
    getOpenTaskLines,
} from "../scripts/create-task_AgentPromptEmitter.ts";

const scriptPath = fileURLToPath(new URL("../scripts/create-task_AgentPromptEmitter.ts", import.meta.url));

test("test_produceFileHunterPromptEndsWithTheTaskTemplate", () => {
    const taskTemplate = '{"taskNumber": 1}';
    const prompt = produceFileHunterPrompt("test task", taskTemplate);
    assert.ok(prompt.trimEnd().endsWith(taskTemplate.trimEnd()));
});

test("test_produceFileHunterPromptOmitsTheOpenTaskList", () => {
    const prompt = produceFileHunterPrompt("test task", '{"taskNumber": 1}');
    assert.doesNotMatch(prompt, /^OPEN \d+:/m);
});

test("test_produceBlockerHunterPromptEndsWithTheOpenTaskLines", () => {
    const openTaskLines = "OPEN 1: do a thing\nOPEN 2: do another thing";
    const prompt = produceBlockerHunterPrompt("test task", openTaskLines);
    assert.ok(prompt.trimEnd().endsWith(openTaskLines.trimEnd()));
});

test("test_produceBlockerHunterPromptAsksForTaskNumber", () => {
    const prompt = produceBlockerHunterPrompt("test task", "OPEN 1: do a thing");
    assert.ok(prompt.includes("taskNumber"));
});

test("test_produceFileHunterPromptEmbedsTheTaskDescription", () => {
    const prompt = produceFileHunterPrompt("a very specific task description", '{"taskNumber": 1}');
    assert.ok(prompt.includes("a very specific task description"));
});

test("test_getOpenTaskLinesReturnsOneLinePerOpenTask", () => {
    const lines = getOpenTaskLines();
    for (const line of lines.split("\n")) {
        if (line === "") continue;
        assert.match(line, /^OPEN \d+: /);
    }
});

test("test_agentPromptEmitterScriptPrintsTheFileHunterPromptForArgvFiles", () => {
    const taskDescription = "test task description";
    const output = execFileSync("node", [scriptPath, "files"], { input: `${taskDescription}\n`, encoding: "utf8" });
    const taskTemplatePath = fileURLToPath(
        new URL("../skills/create-task/template/taskTemplate.json", import.meta.url),
    );
    const taskTemplate = execFileSync("cat", [taskTemplatePath], { encoding: "utf8" }).trimEnd();
    assert.equal(output, produceFileHunterPrompt(taskDescription, taskTemplate));
});

test("test_agentPromptEmitterScriptPrintsTheBlockerHunterPromptForArgvBlockers", () => {
    const taskDescription = "test task description";
    const output = execFileSync("node", [scriptPath, "blockers"], {
        input: `${taskDescription}\n`,
        encoding: "utf8",
    });
    assert.equal(output, produceBlockerHunterPrompt(taskDescription, getOpenTaskLines()));
});

test("test_agentPromptEmitterScriptFailsWhenTheModeArgumentIsUnknown", () => {
    assert.throws(() =>
        execFileSync("node", [scriptPath, "bogus"], { input: "test task\n", encoding: "utf8", stdio: "pipe" }),
    );
});
