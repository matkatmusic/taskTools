// Checks that tasks.json difficulty and overrides flow through resolveAgentOptions into the workflow's agent() calls.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentOptions, StepConfig } from "../scripts/tackle-tasks/generateSteps.ts";
import { resolveAgentOptions } from "../scripts/tackle-tasks/shared/resolveAgentOptions.ts";
import { buildWorkflowScript } from "../scripts/tackle-tasks/generateWorkflow.ts";
import { runWorkflowScript } from "./helpers/runWorkflowScript.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(REPO_ROOT, "scripts/hooks/runStepHook.ts");
const START_KEY = "pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK";
const IMPLEMENT_KEY = "pipeline-implementTask.mmd::IMPLEMENT_TASK";
const TASK_NUMBER = 7;

function writeStep(folder: string, box: string, result: Record<string, unknown>): string {
    const scriptPath = join(folder, `${box}.ts`);
    writeFileSync(scriptPath, `console.log(JSON.stringify({ ...${JSON.stringify({ box, ...result })}, input: process.argv[2] ?? "" }));\n`);
    return scriptPath;
}

function writeTemplate(folder: string, box: string, output: Record<string, unknown>, isPrompt: boolean): string {
    const templatePath = join(folder, `${box}.template.json`);
    const template = isPrompt ? { input: {}, output, agentAnswer: {} } : { input: {}, output };
    writeFileSync(templatePath, JSON.stringify(template));
    return templatePath;
}

function buildFixture(agentOverride?: Record<string, AgentOptions>): { tasksFile: string; stepsConfigPath: string } {
    const folder = mkdtempSync(join(tmpdir(), "workflow-agent-options-"));

    const task: Record<string, unknown> = { taskNumber: TASK_NUMBER, difficulty: 3 };
    if (agentOverride !== undefined) task.agent = agentOverride;
    const tasksFile = join(folder, "tasks.json");
    writeFileSync(tasksFile, JSON.stringify([task]));

    const config: StepConfig = {
        "pipeline-preambleStatusCheck.mmd": [{
            box: "PREAMBLE_STATUS_CHECK",
            script: writeStep(folder, "PREAMBLE_STATUS_CHECK", { scriptSignal: "continue" }),
            template: writeTemplate(folder, "PREAMBLE_STATUS_CHECK", { box: "PREAMBLE_STATUS_CHECK", scriptSignal: "continue", input: "" }, false),
            producesPrompt: false,
            next: [IMPLEMENT_KEY],
        }],
        "pipeline-implementTask.mmd": [{
            box: "IMPLEMENT_TASK",
            script: writeStep(folder, "IMPLEMENT_TASK", { scriptSignal: "prompt", prompt: "" }),
            template: writeTemplate(folder, "IMPLEMENT_TASK", { box: "IMPLEMENT_TASK", scriptSignal: "prompt", prompt: "", input: "" }, true),
            producesPrompt: true,
            next: [],
        }],
    };
    const stepsConfigPath = join(folder, "steps.json");
    writeFileSync(stepsConfigPath, JSON.stringify(config));
    return { tasksFile, stepsConfigPath };
}

// Spawns the real hook like Claude Code does, running START through the stop before IMPLEMENT_TASK.
function runPreamblePass(stepsConfigPath: string, tasksFile: string): Record<string, unknown> {
    const logFile = join(mkdtempSync(join(tmpdir(), "workflow-agent-options-log-")), "run-log.json");
    const prompt = `/run-step ${START_KEY} ${JSON.stringify({ taskNumber: TASK_NUMBER, tasksFile })}`;
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }),
        encoding: "utf8",
        env: { ...process.env, RUN_STEP_LOG: logFile, RUN_STEP_CONFIG: stepsConfigPath },
    });
    const injected = JSON.parse(spawned.stdout.trim());
    const [resultLine] = String(injected.hookSpecificOutput.additionalContext).split("\n");
    return JSON.parse(resultLine);
}

// The IMPLEMENT_TASK prompt line reads `COMMAND: `/taskTools:run-step KEY {...json...}``; the json sits between the marker and the closing backtick.
function parseInputAfterCommand(prompt: string, marker: string): Record<string, unknown> {
    const afterMarker = prompt.slice(prompt.indexOf(marker) + marker.length);
    return JSON.parse(afterMarker.slice(0, afterMarker.indexOf("`")));
}

test("test_workflow_inputAndAgentCallCarryTheDefaultBandWhenTheTaskHasNoOverride", async () => {
    const { tasksFile, stepsConfigPath } = buildFixture();
    resolveAgentOptions(stepsConfigPath, tasksFile, TASK_NUMBER);
    const script = buildWorkflowScript(TASK_NUMBER, stepsConfigPath);
    const preambleResult = runPreamblePass(stepsConfigPath, tasksFile);

    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const stopResult = { ok: true, ran: [IMPLEMENT_KEY], errors: [], outcome: { next: null, payload: "/tmp/q.json" } };
    const agentResults = [
        (prompt: string, options: Record<string, unknown>) => { calls.push({ prompt, options }); return preambleResult; },
        (prompt: string, options: Record<string, unknown>) => { calls.push({ prompt, options }); return stopResult; },
    ];

    await runWorkflowScript(script, { task: TASK_NUMBER, tasksFile }, agentResults);

    assert.equal(calls[0]!.options.model, "sonnet");
    assert.equal(calls[0]!.options.effort, "low");
    assert.equal(calls[1]!.options.model, "claude-opus-4-8[1m]");
    assert.equal(calls[1]!.options.effort, "high");
    const input = parseInputAfterCommand(calls[1]!.prompt, `/taskTools:run-step ${IMPLEMENT_KEY} `);
    assert.deepEqual(input.agent, { model: "claude-opus-4-8[1m]", effort: "high", agentType: "task-7-implement-task" });
});

test("test_workflow_inputAndAgentCallCarryTheTaskOverride", async () => {
    const { tasksFile, stepsConfigPath } = buildFixture({ IMPLEMENT_TASK: { model: "claude-sonnet-5[1m]", effort: "medium" } });
    resolveAgentOptions(stepsConfigPath, tasksFile, TASK_NUMBER);
    const script = buildWorkflowScript(TASK_NUMBER, stepsConfigPath);
    const preambleResult = runPreamblePass(stepsConfigPath, tasksFile);

    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const stopResult = { ok: true, ran: [IMPLEMENT_KEY], errors: [], outcome: { next: null, payload: "/tmp/q.json" } };
    const agentResults = [
        (prompt: string, options: Record<string, unknown>) => { calls.push({ prompt, options }); return preambleResult; },
        (prompt: string, options: Record<string, unknown>) => { calls.push({ prompt, options }); return stopResult; },
    ];

    await runWorkflowScript(script, { task: TASK_NUMBER, tasksFile }, agentResults);

    assert.equal(calls[1]!.options.model, "claude-sonnet-5[1m]");
    assert.equal(calls[1]!.options.effort, "medium");
    const input = parseInputAfterCommand(calls[1]!.prompt, `/taskTools:run-step ${IMPLEMENT_KEY} `);
    assert.deepEqual(input.agent, { model: "claude-sonnet-5[1m]", effort: "medium", agentType: "task-7-implement-task" });
});

test("test_workflow_labelsTheWorkerCallWithThePromptBlock", async () => {
    const { tasksFile, stepsConfigPath } = buildFixture();
    resolveAgentOptions(stepsConfigPath, tasksFile, TASK_NUMBER);
    const script = buildWorkflowScript(TASK_NUMBER, stepsConfigPath);
    const preambleResult = runPreamblePass(stepsConfigPath, tasksFile);

    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const stopResult = { ok: true, ran: [IMPLEMENT_KEY], errors: [], outcome: { next: null, payload: "/tmp/q.json" } };
    const agentResults = [
        (prompt: string, options: Record<string, unknown>) => { calls.push({ prompt, options }); return preambleResult; },
        (prompt: string, options: Record<string, unknown>) => { calls.push({ prompt, options }); return stopResult; },
    ];

    await runWorkflowScript(script, { task: TASK_NUMBER, tasksFile }, agentResults);

    assert.equal(calls[1]!.options.label, "run-step:IMPLEMENT_TASK");
});

test("test_workflow_aBareStartingBlockGetsThatBlocksAgentOptions", async () => {
    const { tasksFile, stepsConfigPath } = buildFixture({ IMPLEMENT_TASK: { model: "claude-sonnet-5[1m]", effort: "medium" } });
    resolveAgentOptions(stepsConfigPath, tasksFile, TASK_NUMBER);
    const script = buildWorkflowScript(TASK_NUMBER, stepsConfigPath);

    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const stopResult = { ok: true, ran: [IMPLEMENT_KEY], errors: [], outcome: { next: null, payload: "/tmp/q.json" } };
    const agentResults = [
        (prompt: string, options: Record<string, unknown>) => { calls.push({ prompt, options }); return stopResult; },
    ];

    await runWorkflowScript(script, { task: TASK_NUMBER, tasksFile, startingBlock: "IMPLEMENT_TASK" }, agentResults);

    assert.equal(calls[0]!.options.model, "claude-sonnet-5[1m]");
    assert.equal(calls[0]!.options.effort, "medium");
    assert.match(calls[0]!.prompt, new RegExp(`/taskTools:run-step ${IMPLEMENT_KEY}`));
});
