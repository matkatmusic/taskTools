// Spawns the hook the way Claude Code does: one JSON payload on stdin, one JSON line on stdout.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointPath, readCheckpoint } from "../scripts/tackle-tasks/shared/checkpoint.ts";
import { START_STEP } from "../scripts/generateWorkflow.ts";
import { buildLockOwner, readSourceRepoLock } from "../scripts/tackle-tasks/shared/sourceRepoLock.ts";

const HOOK = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts/runStepHook.ts");
const FAILURES_EXIT_KEY = "pipeline-failuresExit.mmd::FAILURES_EXIT";
const [PREAMBLE_DIAGRAM, PREAMBLE_BOX] = START_STEP.split("::");

function runHook(prompt: string, configFile?: string, worktree?: string, priorPacketCommand?: string) {
    const logFile = join(mkdtempSync(join(tmpdir(), "run-step-")), "run-log.md");
    // An earlier pass's packet sits beside this run's log, the way .taskTools/runs/ holds every run.
    if (priorPacketCommand !== undefined) {
        const packetsFolder = join(dirname(logFile), "0000", "packets");
        mkdirSync(packetsFolder, { recursive: true });
        writeFileSync(join(packetsFolder, "X-0-1.json"), JSON.stringify({ input: {}, command: priorPacketCommand, commandOutput: "", output: {} }));
    }
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }),
        encoding: "utf8",
        env: { ...process.env, RUN_STEP_LOG: logFile, ...(configFile ? { RUN_STEP_CONFIG: configFile } : {}) },
    });
    const injected = spawned.stdout.trim();
    // The hook output is the first line; after a prompt stop, the agent's instructions follow it.
    const [resultLine, ...instructionLines] = injected ? String(JSON.parse(injected).hookSpecificOutput.additionalContext).split("\n") : [];
    const result = resultLine ? JSON.parse(resultLine) : null;
    return {
        injected,
        result,
        instructions: instructionLines.join("\n"),
        readLog: () => readFileSync(logFile, "utf8"),
        checkpoint: worktree ? readCheckpoint(worktree) : null,
    };
}

// Builds a throwaway config whose steps live in a temp folder, so a walk never touches the repo's own.
function configWith(build: (writeStep: (box: string, result: Record<string, unknown>) => string, folder: string) => Record<string, { box: string; script: string; producesPrompt?: boolean; next: string[] }[]>) {
    const folder = mkdtempSync(join(tmpdir(), "run-step-steps-"));
    const outputByBox: Record<string, Record<string, unknown>> = {};
    const writeStep = (box: string, result: Record<string, unknown>) => {
        const scriptPath = join(folder, `${box}.ts`);
        writeFileSync(scriptPath, `console.log(JSON.stringify({ ...${JSON.stringify({ box, ...result })}, input: process.argv[2] ?? "" }));\n`);
        outputByBox[box] = { box, ...result, input: "" };
        return scriptPath;
    };
    const configFile = join(folder, "steps.json");
    const config = build(writeStep, folder);
    // Every entry needs a template; a producesPrompt entry also needs an agentAnswer for its schema.
    for (const entries of Object.values(config)) {
        for (const entry of entries) {
            const templatePath = join(folder, `${entry.box}.template.json`);
            const output = outputByBox[entry.box] ?? { box: entry.box, scriptSignal: "stop" };
            const isPrompt = entry.producesPrompt ?? false;
            const template = isPrompt ? { input: {}, output, agentAnswer: {} } : { input: {}, output };
            writeFileSync(templatePath, JSON.stringify(template));
            (entry as Record<string, unknown>).template = templatePath;
            (entry as Record<string, unknown>).producesPrompt = isPrompt;
        }
    }
    writeFileSync(configFile, JSON.stringify(config));
    return configFile;
}

test("test_runStepHook_staysSilentForAPromptThatNamesAnotherSkill", () => {
    assert.equal(runHook("/some-other-skill SAY_HELLO").injected, "");
});

test("test_runStepHook_staysSilentForAPromptThatIsNotACommand", () => {
    assert.equal(runHook("please run SAY_HELLO for me").injected, "");
});

// This repo ships no sample diagrams, so the bare-name tests bring their own SAY_HELLO.
function sayHelloConfig() {
    return configWith(writeStep => ({
        "pipeline.mmd": [{ box: "SAY_HELLO", script: writeStep("SAY_HELLO", { scriptSignal: "stop" }), next: [] }],
    }));
}

test("test_runStepHook_answersANamespacedInvocation", () => {
    assert.equal(runHook("/taskTools:run-step SAY_HELLO", sayHelloConfig()).result.ok, true);
});

test("test_runStepHook_namesTheKnownBlocksWhenTheBlockIsUnknown", () => {
    const { result } = runHook("/run-step NOT_A_BLOCK", sayHelloConfig());
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /no block named NOT_A_BLOCK/);
    assert.match(result.errors[0], /pipeline\.mmd::SAY_HELLO/);
});

test("test_runStepHook_refusesABareBoxTwoDiagramsBothName", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "SHARED", script: writeStep("SHARED", { scriptSignal: "stop" }), next: [] }],
        "two.mmd": [{ box: "SHARED", script: writeStep("SHARED", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook("/run-step SHARED", configFile);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /named by more than one diagram/);
});

// A box named in a diagram's next but not entered under that diagram falls back to any diagram that has it.
test("test_runStepHook_fallsBackToAnotherDiagramWhenTheSameDiagramHasNoSuchBox", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["SHARED"] }],
        "two.mmd": [{ box: "SHARED", script: writeStep("SHARED", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ran, ["one.mmd::A", "two.mmd::SHARED"]);
});

test("test_runStepHook_startsAtABoxNamedWithItsDiagram", () => {
    const folder = mkdtempSync(join(tmpdir(), "run-step-steps-"));
    const writeShared = (from: string) => {
        const scriptPath = join(folder, `SHARED-${from}.ts`);
        writeFileSync(scriptPath, `console.log(JSON.stringify({ box: "SHARED", scriptSignal: "stop", from: "${from}", input: process.argv[2] ?? "" }));\n`);
        const templatePath = join(folder, `SHARED-${from}.template.json`);
        writeFileSync(templatePath, JSON.stringify({ input: {}, output: { box: "SHARED", scriptSignal: "stop", from: "", input: "" } }));
        return { box: "SHARED", script: scriptPath, template: templatePath, producesPrompt: false, next: [] };
    };
    const configFile = join(folder, "steps.json");
    writeFileSync(configFile, JSON.stringify({ "one.mmd": [writeShared("one")], "two.mmd": [writeShared("two")] }));
    const { result } = runHook("/run-step two.mmd::SHARED", configFile);
    assert.equal(JSON.parse(readFileSync(result.outcome.payload, "utf8")).from, "two");
});

test("test_runStepHook_walksUntilAStepSignalsStop", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "continue" }), next: ["C"] },
            { box: "C", script: writeStep("C", { scriptSignal: "stop", why: "an agent takes over" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.deepEqual(result.ran, ["one.mmd::A", "one.mmd::B", "one.mmd::C"]);
    assert.equal(result.outcome.next, null);
});

test("test_runStepHook_walksAcrossASeamIntoAnotherDiagram", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "HANDOFF", script: writeStep("HANDOFF", { scriptSignal: "continue" }), next: ["two.mmd::SWEEP"] }],
        "two.mmd": [{ box: "SWEEP", script: writeStep("SWEEP", { scriptSignal: "stop" }), next: [] }],
    }));
    assert.deepEqual(runHook("/run-step HANDOFF", configFile).result.ran, ["one.mmd::HANDOFF", "two.mmd::SWEEP"]);
});

test("test_runStepHook_failsWhenABoxThatWantsToContinueHasAnEmptyNext", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: [] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /one\.mmd::A has an empty next; say where it goes next/);
});

test("test_runStepHook_endsCleanlyWhenATerminalBoxSignalsStop", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, true);
    assert.equal(result.outcome.next, null);
});

// A block that prints a prompt stops the walk; the prompt waits in the packet file for an agent.
test("test_runStepHook_stopsWhenABlockPrintsAPromptForAnAgent", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "prompt", prompt: "read the plan and answer" }), producesPrompt: true, next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, true);
    assert.equal(result.outcome.next, "one.mmd::B");
    assert.deepEqual(result.ran, ["one.mmd::A"]);
    assert.equal(JSON.parse(readFileSync(result.outcome.payload, "utf8")).prompt, "read the plan and answer");
});

// The skill body says nothing about prompts; the hook output itself tells the agent what to do with the file.
test("test_runStepHook_tellsTheAgentToAnswerIntoThePacketFileAfterAPromptStop", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result, instructions } = runHook("/run-step A", configFile);
    assert.match(instructions, new RegExp(`The file at ${result.outcome.payload} holds a prompt`));
    assert.match(instructions, new RegExp(`3\\. Write the object the prompt asks you to return into ${result.outcome.payload}`));
    assert.match(instructions, /4\. Only after step 3 is done, return the JSON object above verbatim/);
});

test("test_runStepHook_givesNoInstructionsAfterAStopBlock", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    assert.equal(runHook("/run-step A", configFile).instructions, "");
});

// The diagram's returns_a_prompt mark and the printed scriptSignal must agree, both ways.
test("test_runStepHook_failsWhenAMarkedBlockDoesNotPrintAPrompt", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "continue" }), producesPrompt: true, next: ["B"] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /one\.mmd::A is marked returns_a_prompt but printed scriptSignal "continue"/);
});

test("test_runStepHook_failsWhenAnUnmarkedBlockPrintsAPrompt", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "prompt", prompt: "surprise" }), next: [] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /one\.mmd::A printed scriptSignal "prompt" but is not marked returns_a_prompt/);
});

// The block's printed object must match its declared contract, so drift fails loudly at the hop.
test("test_runStepHook_failsWhenABlockBreaksItsOutputContract", () => {
    const configFile = configWith((writeStep, folder) => {
        const brokenScript = join(folder, "A-broken.ts");
        writeFileSync(brokenScript, `console.log(JSON.stringify({ box: "A", scriptSignal: "stop", input: 5 }));\n`);
        writeStep("A", { scriptSignal: "stop", input: "" });
        return { "one.mmd": [{ box: "A", script: brokenScript, next: [] }] };
    });
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /one\.mmd::A output breaks its contract/);
    assert.match(result.errors[1], /input should be string, got number/);
});

// The walk's first input crosses a trust boundary, so it must match the start block's declared input.
test("test_runStepHook_failsWhenTheStartInputBreaksTheBlocksInputContract", () => {
    const folder = mkdtempSync(join(tmpdir(), "run-step-steps-"));
    const scriptPath = join(folder, "A.ts");
    writeFileSync(scriptPath, `console.log(JSON.stringify({ box: "A", scriptSignal: "stop", input: process.argv[2] ?? "" }));\n`);
    const templatePath = join(folder, "A.template.json");
    writeFileSync(templatePath, JSON.stringify({ input: { message: "", additionalData: {} }, output: { box: "A", scriptSignal: "stop", input: "" } }));
    const configFile = join(folder, "steps.json");
    writeFileSync(configFile, JSON.stringify({ "one.mmd": [{ box: "A", script: scriptPath, template: templatePath, producesPrompt: false, next: [] }] }));
    const { result } = runHook(`/run-step A {"wrong":"shape"}`, configFile);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /one\.mmd::A input breaks its contract/);
    assert.match(result.errors[1], /message is missing/);
});

// The workflow reads outcome.next instead of keeping its own copy of the arrows.
test("test_runStepHook_namesTheStepThatFollowsTheOneItStoppedAt", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    assert.equal(runHook("/run-step A", configFile).result.outcome.next, "one.mmd::B");
});

// The walk runs into a prompt block's own script and stops there, so the block's side effects still happen.
test("test_runStepHook_walksIntoAPromptBlockAndHandsItsInputAsThePacket", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", taskNumber: 7, runId: "run-1" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["C"] },
            { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.deepEqual(result.ran, ["one.mmd::A", "one.mmd::B"]);
    assert.equal(result.outcome.next, "one.mmd::C");
    // The prompt packet also carries when the prompt block started, so the next pass can log the agent's time.
    const { startedAt, ...packet } = JSON.parse(readFileSync(result.outcome.payload, "utf8"));
    assert.equal(typeof startedAt, "number");
    assert.deepEqual(packet, { box: "A", scriptSignal: "continue", taskNumber: 7, runId: "run-1", input: "", prompt: "answer" });
});

// A pass starting at the prompt block runs it; the packet is that pass's given input.
test("test_runStepHook_handsAPromptBlocksOwnInputAsThePacket", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "B", script: writeStep("B", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["C"] },
            { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook(`/run-step B {"box":"A","scriptSignal":"continue","taskNumber":7}`, configFile);
    const { startedAt: _startedAt, ...packet } = JSON.parse(readFileSync(result.outcome.payload, "utf8"));
    assert.deepEqual(packet, { box: "A", scriptSignal: "continue", taskNumber: 7, prompt: "answer" });
});

// After a stop block the packet is that block's whole output, box and scriptSignal included.
test("test_runStepHook_handsAStopBlocksOutputAsThePacket", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook("/run-step A just words", configFile);
    assert.deepEqual(JSON.parse(readFileSync(result.outcome.payload, "utf8")), { box: "A", scriptSignal: "stop", input: "just words" });
});

// A start input naming a packetFile expands to that file, with the answer the agent wrote into it.
test("test_runStepHook_expandsAPacketFileIntoTheStartInput", () => {
    const folder = mkdtempSync(join(tmpdir(), "run-step-packet-"));
    const packetFile = join(folder, "task-packet.json");
    writeFileSync(packetFile, JSON.stringify({ taskNumber: 7, prompt: "say x", answer: "x" }));
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook(`/run-step A {"packetFile":"${packetFile}"}`, configFile);
    const startInput = JSON.parse(JSON.parse(readFileSync(result.outcome.payload, "utf8")).input);
    assert.deepEqual(startInput, { taskNumber: 7, answer: "x" });
});

// The block script returns a prompt in milliseconds; the agent's own work runs after the hook returns, until the next call consumes the packet.
test("test_runStepHook_logsHowLongTheAgentTookOnAPromptBlock", () => {
    // Setup: the packet block A wrote, holding when A started three seconds ago and the agent's answer.
    const folder = mkdtempSync(join(tmpdir(), "run-step-packet-"));
    const packetFile = join(folder, "A-1.json");
    writeFileSync(packetFile, JSON.stringify({ taskNumber: 7, prompt: "say x", answer: "x", startedAt: Date.now() - 3000 }));
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] }],
    }));
    // Action: the next call consumes that packet.
    const log = runHook(`/run-step B {"packetFile":"${packetFile}"}`, configFile).readLog();
    // Verification: the log says how long the agent took on A, measured from the startedAt in the packet.
    const agentLine = log.split("\n").find(line => /^### A agent took \d+ ms$/.test(line));
    assert.ok(agentLine, log);
    assert.ok(Number(agentLine!.match(/\d+/)![0]) >= 3000, agentLine);
});

// A typed `/tackle-tasks reset N` is the hook's job, not the agent's: the hook runs the reset and hands back its lines.
test("test_runStepHook_runsTheResetForATackleTasksResetPrompt", () => {
    // Setup: a repository whose tasks.json holds open task 7 with run state from an earlier run.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "run-step-reset-")));
    spawnSync("git", ["-C", cwd, "init", "-q"]);
    mkdirSync(join(cwd, ".taskTools"), { recursive: true });
    writeFileSync(join(cwd, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber: 7, title: "t", run: { active: false, history: [] }, codexReviewNotes: [] }]));
    writeFileSync(join(cwd, ".taskTools", "completedTasks.json"), "[]");
    // Action: the user types the reset line.
    const { RUN_STEP_LOG: _unset, ...env } = process.env;
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        cwd, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "/tackle-tasks reset 7" }), encoding: "utf8", env,
    });
    // Verification: the hook reports the reset and tasks.json no longer holds the run state.
    const additionalContext = String(JSON.parse(spawned.stdout.trim()).hookSpecificOutput.additionalContext);
    assert.match(additionalContext, /task 7 run state cleared/);
    const [task] = JSON.parse(readFileSync(join(cwd, ".taskTools", "tasks.json"), "utf8"));
    assert.equal("run" in task, false);
});

test("test_runStepHook_namesTheBranchTheBlockChoseAsTheNextStep", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "prompt", prompt: "answer", next: "C" }), producesPrompt: true, next: ["B", "C"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
            { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    assert.equal(runHook("/run-step A", configFile).result.outcome.next, "one.mmd::C");
});

test("test_runStepHook_leavesTheNextStepNullAtTheEndOfAPath", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    assert.equal(runHook("/run-step A", configFile).result.outcome.next, null);
});

test("test_runStepHook_failsWhenTheSignalIsNotOneOfTheThree", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "maybe" }), next: [] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /scriptSignal must be one of "continue", "stop", "prompt", not "maybe"/);
});

test("test_runStepHook_failsWhenADecisionBoxDoesNotNameItsChoice", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["B", "C"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
            { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.deepEqual(result.ran, ["one.mmd::A"]);
    assert.match(result.errors[0], /points at B, C; its output must name one in next/);
});

test("test_runStepHook_takesTheBranchTheOutputNames", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", next: "C" }), next: ["B", "C"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
            { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    assert.deepEqual(runHook("/run-step A", configFile).result.ran, ["one.mmd::A", "one.mmd::C"]);
});

// A box after a decision box spreads its input; the decision's next must not ride along and re-route the walk.
test("test_runStepHook_dropsTheChosenNextBeforeHandingTheOutputToTheNextBox", () => {
    const configFile = configWith((writeStep, folder) => {
        const spreadingScript = join(folder, "B-spreads.ts");
        writeFileSync(spreadingScript, `console.log(JSON.stringify({ ...JSON.parse(process.argv[2]), box: "B", scriptSignal: "continue" }));\n`);
        writeStep("B", { scriptSignal: "continue" });
        return {
            "one.mmd": [
                { box: "A", script: writeStep("A", { scriptSignal: "continue", next: "B" }), next: ["B", "C"] },
                { box: "B", script: spreadingScript, next: ["D"] },
                { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
                { box: "D", script: writeStep("D", { scriptSignal: "stop" }), next: [] },
            ],
        };
    });
    const { result } = runHook("/run-step A", configFile);
    assert.deepEqual(result.ran, ["one.mmd::A", "one.mmd::B", "one.mmd::D"]);
});

test("test_runStepHook_failsWhenTheChosenBranchIsNotInNext", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", next: "ELSEWHERE" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /next "ELSEWHERE" is not one of B/);
});

test("test_runStepHook_stopsWhenTheNextBoxIsNotInTheConfig", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["gone.mmd::MISSING"] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /gone\.mmd::MISSING is not in the config/);
});

// git prints "Reset branch" on stderr after the step's result, so stderr must not hide the result line.
test("test_runStepHook_readsTheResultFromStdoutWhenAStepWritesToStderrAfterIt", () => {
    const configFile = configWith((_writeStep, folder) => {
        const scriptPath = join(folder, "A.ts");
        writeFileSync(scriptPath, `console.log(JSON.stringify({ box: "A", scriptSignal: "stop" }));\nconsole.error("Reset branch 'task-1'");\n`);
        return { "one.mmd": [{ box: "A", script: scriptPath, next: [] }] };
    });
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ran, ["one.mmd::A"]);
});

test("test_runStepHook_stopsWhenAStepPrintsNoResultObject", () => {
    const configFile = configWith((_writeStep, folder) => {
        const scriptPath = join(folder, "A.ts");
        writeFileSync(scriptPath, `console.log("just words");\n`);
        return { "one.mmd": [{ box: "A", script: scriptPath, next: [] }] };
    });
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0], "one.mmd::A printed no result object");
});

test("test_runStepHook_stopsWhenAStepExitsNonZero", () => {
    const configFile = configWith((_writeStep, folder) => {
        const scriptPath = join(folder, "A.ts");
        writeFileSync(scriptPath, `process.exit(3);\n`);
        return { "one.mmd": [{ box: "A", script: scriptPath, next: [] }] };
    });
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0], "one.mmd::A exited 3");
});

test("test_runStepHook_logsOneBlockForEveryStepItRan", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const log = runHook("/run-step A", configFile).readLog();
    assert.match(log, /^## ======= A =======$[\s\S]*^## ======= B =======$/m);
});

test("test_runStepHook_logsHowLongEachBlockTook", () => {
    // Steps: run the hook on the two-block fixture, A continuing into B.
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const log = runHook("/run-step A", configFile).readLog();
    // Every block entry logs one line with how long that block took.
    // const blockTookLines = log.split("\n").filter(line => /^### end output ====== \S+ took \d+ ms$/.test(line));
    const blockTookLines = log.split("\n").filter(line => /^### \S+ took \d+ ms$/.test(line));
    assert.equal(blockTookLines.length, 2);
});

test("test_runStepHook_logsTheFailureWhenTheWalkCannotFinish", () => {
    const log = runHook("/run-step NOT_A_BLOCK").readLog();
    assert.match(log, /^## ======= FAILURE =======\n```json\n\{\n    "invocation": "\/run-step NOT_A_BLOCK",\n    "ran": \[\],\n    "errors": \[\n        "no block named NOT_A_BLOCK; known: /m);
});

test("test_runStepHook_handsTheRestOfTheLineToTheFirstBlock", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook(`/run-step A {"name":"matt"}`, configFile);
    assert.equal(JSON.parse(readFileSync(result.outcome.payload, "utf8")).input, `{"name":"matt"}`);
});

test("test_runStepHook_givesTheFirstBlockAnEmptyInputWhenTheLineHasNone", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(JSON.parse(readFileSync(result.outcome.payload, "utf8")).input, "");
});

// Obsolete: the command line moved out of the log and into the packet. See the "stores" test below.
// test("test_runStepHook_logsTheInputAsPartOfThePasteableCommand", () => {
//     const configFile = configWith(writeStep => ({
//         "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
//     }));
//     const log = runHook(`/run-step A it's here`, configFile).readLog();
//     assert.match(log, /### === command ======\nnode --no-inspect .*A\.ts 'it'\\''s here'\n### end command ======/);
// });

test("test_runStepHook_storesTheInputAsPartOfThePasteableCommand", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook(`/run-step A it's here`, configFile);
    const packetsFolder = dirname(result.outcome.payload);
    const packetName = readdirSync(packetsFolder).find(name => /^A-\d+-1\.json$/.test(name))!;
    const packet = JSON.parse(readFileSync(join(packetsFolder, packetName), "utf8"));
    assert.match(packet.command, /^node --no-inspect .*A\.ts 'it'\\''s here'$/);
});

test("test_runStepHook_handsOneBlocksOutputToTheNextBlock", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", greeting: "hello" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A first-input", configFile);
    const received = JSON.parse(JSON.parse(readFileSync(result.outcome.payload, "utf8")).input);
    assert.equal(received.box, "A");
    assert.equal(received.greeting, "hello");
    assert.equal(received.input, "first-input");
});

test("test_runStepHook_threadsOutputThroughEveryHopOfAWalk", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "continue" }), next: ["C"] },
            { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    const seenByC = JSON.parse(JSON.parse(readFileSync(result.outcome.payload, "utf8")).input);
    assert.equal(seenByC.box, "B");
    assert.equal(JSON.parse(seenByC.input).box, "A");
});

// Obsolete: the command line moved out of the log and into the packet. See the "stores" test below.
// test("test_runStepHook_logsTheThreadedOutputAsThePasteableCommand", () => {
//     const configFile = configWith(writeStep => ({
//         "one.mmd": [
//             { box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["B"] },
//             { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
//         ],
//     }));
//     const log = runHook("/run-step A", configFile).readLog();
//     assert.match(log, /node --no-inspect .*B\.ts '\{"box":"A","scriptSignal":"continue","input":""\}'/);
// });

test("test_runStepHook_storesTheThreadedOutputAsThePasteableCommand", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    const packetsFolder = dirname(result.outcome.payload);
    const packetName = readdirSync(packetsFolder).find(name => /^B-\d+-2\.json$/.test(name))!;
    const packet = JSON.parse(readFileSync(join(packetsFolder, packetName), "utf8"));
    assert.match(packet.command, /node --no-inspect .*B\.ts '\{"box":"A","scriptSignal":"continue","input":""\}'/);
});

// PostToolUse names the skill and its args apart. That is how an agent reaches the hook.
function runSkillHook(skill: string, args: string, configFile?: string) {
    const logFile = join(mkdtempSync(join(tmpdir(), "run-step-")), "run-log.md");
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill, args } }),
        encoding: "utf8",
        env: { ...process.env, RUN_STEP_LOG: logFile, ...(configFile ? { RUN_STEP_CONFIG: configFile } : {}) },
    });
    const injected = spawned.stdout.trim();
    const result = injected ? JSON.parse(String(JSON.parse(injected).hookSpecificOutput.additionalContext).split("\n")[0]) : null;
    return { injected, result };
}

test("test_runStepHook_runsABlockWhenAnAgentCallsTheSkill", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    assert.equal(runSkillHook("run-step", "A", configFile).result.ok, true);
});

test("test_runStepHook_runsABlockWhenAnAgentCallsTheSkillNamespaced", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    assert.equal(runSkillHook("taskTools:run-step", "A", configFile).result.ok, true);
});

test("test_runStepHook_staysSilentWhenAnAgentCallsAnotherSkill", () => {
    assert.equal(runSkillHook("some-other-skill", "A").injected, "");
});

test("test_runStepHook_handsTheSkillArgsToTheFirstBlock", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runSkillHook("run-step", `A {"name":"matt"}`, configFile);
    assert.equal(JSON.parse(readFileSync(result.outcome.payload, "utf8")).input, `{"name":"matt"}`);
});

test("test_runStepHook_echoesPostToolUseAsTheHookEventName", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "run-step", args: "A" } }),
        encoding: "utf8",
        env: { ...process.env, RUN_STEP_CONFIG: configFile },
    });
    assert.equal(JSON.parse(spawned.stdout.trim()).hookSpecificOutput.hookEventName, "PostToolUse");
});

// Spawns the hook with no RUN_STEP_LOG override, from a throwaway repo folder, so the real run layout is what gets tested.
function runHookIn(cwd: string, prompt: string, configFile: string) {
    const { RUN_STEP_LOG: _unset, ...env } = process.env;
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        cwd,
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }),
        encoding: "utf8",
        env: { ...env, RUN_STEP_CONFIG: configFile },
    });
    const injected = spawned.stdout.trim();
    const result = injected ? JSON.parse(String(JSON.parse(injected).hookSpecificOutput.additionalContext).split("\n")[0]) : null;
    const runsFolder = join(cwd, ".taskTools", "runs");
    return { result, runsFolder, runsEntries: () => readdirSync(runsFolder).sort() };
}

const STAMPED_LOG = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+-run-log\.md$/;

test("test_runStepHook_writesOneStampedRunLogAndOnePacketsFolderPerRun", () => {
    // Scenario: a fresh /run-step call starts a run; its log and its packets are named by one timestamp.  Steps: A continues into B, which stops on a prompt, so the hook writes one packet.
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "prompt", prompt: "do it" }), producesPrompt: true, next: ["A"] },
        ],
    }));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "run-step-repo-")));
    const { result, runsFolder, runsEntries } = runHookIn(cwd, "/run-step A", configFile);
    // The runs folder holds exactly <stamp>-run-log.md and the <stamp> folder.
    const [stampFolder, logName] = runsEntries();
    assert.match(logName, STAMPED_LOG);
    assert.equal(logName, `${stampFolder}-run-log.md`);
    // The packet sits under <stamp>/packets.
    assert.equal(dirname(result.outcome.payload), join(runsFolder, stampFolder, "packets"));
    assert.match(readFileSync(join(runsFolder, logName), "utf8"), /======= A =======/);
});

test("test_runStepHook_namesTheRunFolderWithTheProcessId", () => {
    // Scenario: the run folder name ends with the hook process's own pid, so two runs launched in the same second still land in different folders.
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "run-step-repo-")));
    const { result, runsEntries } = runHookIn(cwd, "/run-step A", configFile);
    // Step: read the hook process's pid out of the packet file name it already checks.
    const packetsFolder = dirname(result.outcome.payload);
    const packetName = readdirSync(packetsFolder).find(name => /^A-\d+-1\.json$/.test(name))!;
    const pid = packetName.match(/^A-(\d+)-1\.json$/)![1];
    // Step: the run folder name is a timestamp followed by that pid.
    const stampFolder = runsEntries().find(name => !name.endsWith("run-log.md"))!;
    assert.match(stampFolder, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+$/);
    assert.ok(stampFolder.endsWith(`-${pid}`));
});

test("test_runStepHook_writesOnePacketForEveryBlockItRan", () => {
    // Scenario: a two-block walk writes one packet per block pass, named by box, pid, and pass order.
    // Steps: A continues into B, and B stops.
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "run-step-repo-")));
    const { runsFolder, runsEntries } = runHookIn(cwd, "/run-step A", configFile);
    // List the packets folder under the run's stamp folder.
    const stampFolder = runsEntries().find(name => !name.endsWith("run-log.md"))!;
    const packetsFolder = join(runsFolder, stampFolder, "packets");
    const packetNames = readdirSync(packetsFolder);
    // One packet per block ran, named by box, pid, and the order it ran in: A is 1, B is 2.
    const aPacketName = packetNames.find(name => /^A-\d+-1\.json$/.test(name))!;
    const bPacketName = packetNames.find(name => /^B-\d+-2\.json$/.test(name))!;
    assert.ok(aPacketName);
    assert.ok(bPacketName);
    for (const packetName of [aPacketName, bPacketName]) {
        const packet = JSON.parse(readFileSync(join(packetsFolder, packetName), "utf8"));
        // Each packet holds exactly the four values the log used to print.
        assert.deepEqual(Object.keys(packet).sort(), ["command", "commandOutput", "input", "output"]);
        assert.equal(packet.input.invocation, "/run-step A");
        assert.match(packet.command, /^node --no-inspect/);
    }
});

test("test_runStepHook_writesAPacketForABlockThatFailed", () => {
    // Scenario: a block that exits non-zero still gets a packet, holding its stderr text.
    const configFile = configWith((_writeStep, folder) => {
        const scriptPath = join(folder, "A.ts");
        writeFileSync(scriptPath, `console.error("boom from A");\nprocess.exit(3);\n`);
        return { "one.mmd": [{ box: "A", script: scriptPath, next: [] }] };
    });
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "run-step-repo-")));
    const { result, runsFolder, runsEntries } = runHookIn(cwd, "/run-step A", configFile);
    assert.equal(result.ok, false);
    const stampFolder = runsEntries().find(name => !name.endsWith("run-log.md"))!;
    const packetsFolder = join(runsFolder, stampFolder, "packets");
    const packetName = readdirSync(packetsFolder).find(name => /^A-\d+-1\.json$/.test(name))!;
    const packet = JSON.parse(readFileSync(join(packetsFolder, packetName), "utf8"));
    assert.match(packet.commandOutput, /boom from A/);
});

test("test_runStepHook_writesOnePacketPerPassWhenABlockRunsTwice", () => {
    // Scenario: the graph loops back through the same box; each pass writes its own packet.
    // Steps: A continues into B; B continues back into A, which this time stops.
    const configFile = configWith((writeStep, folder) => {
        const aScript = join(folder, "A.ts");
        writeFileSync(aScript, [
            `const input = process.argv[2] ?? "";`,
            `const visited = input.includes('"visited":true');`,
            `console.log(JSON.stringify(visited ? { box: "A", scriptSignal: "stop", input } : { box: "A", scriptSignal: "continue", next: "B", input }));`,
        ].join("\n"));
        return {
            "one.mmd": [
                { box: "A", script: aScript, next: ["B"] },
                { box: "B", script: writeStep("B", { scriptSignal: "continue", next: "A", visited: true }), next: ["A"] },
            ],
        };
    });
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "run-step-repo-")));
    const { result, runsFolder, runsEntries } = runHookIn(cwd, "/run-step A", configFile);
    assert.deepEqual(result.ran, ["one.mmd::A", "one.mmd::B", "one.mmd::A"]);
    const stampFolder = runsEntries().find(name => !name.endsWith("run-log.md"))!;
    const packetsFolder = join(runsFolder, stampFolder, "packets");
    // Two packet files for box A; the pass number differs between them.
    const aPacketNames = readdirSync(packetsFolder).filter(name => /^A-\d+-\d+\.json$/.test(name));
    assert.equal(aPacketNames.length, 2);
    const passNumbers = aPacketNames.map(name => Number(name.match(/^A-\d+-(\d+)\.json$/)![1])).sort((a, b) => a - b);
    assert.notEqual(passNumbers[0], passNumbers[1]);
});

test("test_runStepHook_appendsAPacketFilePassToTheRunThePacketBelongsTo", () => {
    // Scenario: a later pass names a packet file; the hook logs into that run's log, not a new one.  Steps: A packet from run S already exists.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "run-step-repo-")));
    const packetsFolder = join(cwd, ".taskTools", "runs", "S", "packets");
    mkdirSync(packetsFolder, { recursive: true });
    const packetFile = join(packetsFolder, "A-1.json");
    writeFileSync(packetFile, JSON.stringify({ prompt: "old" }));
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] }],
    }));
    // The pass that consumes it logs to S-run-log.md and writes its packet under S/packets.
    const { result, runsFolder, runsEntries } = runHookIn(cwd, `/run-step C ${JSON.stringify({ packetFile })}`, configFile);
    assert.deepEqual(runsEntries(), ["S", "S-run-log.md"]);
    assert.match(readFileSync(join(runsFolder, "S-run-log.md"), "utf8"), /======= C =======/);
    assert.equal(dirname(result.outcome.payload), packetsFolder);
});

test("test_runStepHook_keepsThePacketsOfARunThatCompleted", () => {
    // Scenario: the STOP of the merge-succeeded chain ends a completed run; its packets stay too.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "run-step-repo-")));
    const packetsFolder = join(cwd, ".taskTools", "runs", "S", "packets");
    mkdirSync(packetsFolder, { recursive: true });
    const packetFile = join(packetsFolder, "X-1.json");
    writeFileSync(packetFile, "{}");
    const configFile = configWith(writeStep => ({
        "pipeline-mergeSucceededExit.mmd": [{ box: "STOP", script: writeStep("STOP", { scriptSignal: "stop" }), next: [] }],
    }));
    runHookIn(cwd, `/run-step pipeline-mergeSucceededExit.mmd::STOP ${JSON.stringify({ packetFile })}`, configFile);
    assert.equal(existsSync(packetFile), true);
});

test("test_runStepHook_keepsThePacketsOfARunThatFailed", () => {
    // Scenario: the STOP of the failures chain ends a failed run; its packets stay for a resume.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "run-step-repo-")));
    const packetsFolder = join(cwd, ".taskTools", "runs", "S", "packets");
    mkdirSync(packetsFolder, { recursive: true });
    const packetFile = join(packetsFolder, "X-1.json");
    writeFileSync(packetFile, "{}");
    const configFile = configWith(writeStep => ({
        "pipeline-failuresExit.mmd": [{ box: "STOP", script: writeStep("STOP", { scriptSignal: "stop" }), next: [] }],
    }));
    runHookIn(cwd, `/run-step pipeline-failuresExit.mmd::STOP ${JSON.stringify({ packetFile })}`, configFile);
    assert.equal(existsSync(packetFile), true);
});

// A checkpoint lets a killed run pick up where it stopped; the hook writes one before every block that has a worktree.
test("test_runStepHook_keepsTheCheckpointAtTheBlockBeforeAPromptBlock", () => {
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", worktree, runId: "r1", taskNumber: 7, projectRoot: worktree }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["C"] },
            { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const startInput = JSON.stringify({ taskNumber: 7, worktree, runId: "r1", projectRoot: worktree });
    const { checkpoint } = runHook(`/run-step A ${startInput}`, configFile, worktree);
    assert.equal(checkpoint?.block, "one.mmd::A");
    assert.equal(checkpoint?.state, "running");
    assert.equal(checkpoint?.input, startInput);
});

test("test_runStepHook_keepsTheCheckpointWhenTheBlockAfterAPromptDies", () => {
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    const configFile = configWith((writeStep, folder) => {
        const dyingScript = join(folder, "C.ts");
        writeFileSync(dyingScript, "process.exit(1);\n");
        return {
            "one.mmd": [
                { box: "A", script: writeStep("A", { scriptSignal: "continue", worktree, runId: "r1", taskNumber: 7, projectRoot: worktree }), next: ["B"] },
                { box: "B", script: writeStep("B", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["C"] },
                { box: "C", script: dyingScript, next: [] },
            ],
        };
    });
    const startInput = JSON.stringify({ taskNumber: 7, worktree, runId: "r1", projectRoot: worktree });
    const first = runHook(`/run-step A ${startInput}`, configFile, worktree);
    const { result, checkpoint } = runHook(`/run-step one.mmd::C ${JSON.stringify({ packetFile: first.result.outcome.payload })}`, configFile, worktree);
    assert.equal(result.ok, false);
    assert.equal(checkpoint?.block, "one.mmd::A");
    assert.equal(checkpoint?.state, "running");
    assert.equal(checkpoint?.input, startInput);
});

test("test_runStepHook_failsTheBlockAfterAPromptBackToTheBlockBeforeIt", () => {
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", worktree, runId: "r1", taskNumber: 7, projectRoot: worktree }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["C"] },
            { box: "C", script: writeStep("C", { scriptSignal: "continue", next: FAILURES_EXIT_KEY, exitType: "run-failed", exitNote: "n", worktree, runId: "r1", taskNumber: 7, projectRoot: worktree }), next: [FAILURES_EXIT_KEY] },
        ],
        "pipeline-failuresExit.mmd": [
            { box: "FAILURES_EXIT", script: writeStep("FAILURES_EXIT", { scriptSignal: "continue" }), next: ["STOP"] },
            { box: "STOP", script: writeStep("STOP", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const startInput = JSON.stringify({ taskNumber: 7, worktree, runId: "r1", projectRoot: worktree });
    const first = runHook(`/run-step A ${startInput}`, configFile, worktree);
    const { checkpoint } = runHook(`/run-step one.mmd::C ${JSON.stringify({ packetFile: first.result.outcome.payload })}`, configFile, worktree);
    assert.equal(checkpoint?.block, "one.mmd::A");
    assert.equal(checkpoint?.state, "failed");
    assert.equal(checkpoint?.exitType, "run-failed");
    assert.equal(checkpoint?.input, startInput);
});

test("test_runStepHook_writesNoCheckpointBeforeAWorktreeExists", () => {
    const missingWorktree = join(tmpdir(), `run-step-missing-${process.pid}-${Date.now()}`);
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", worktree: missingWorktree, runId: "r1", taskNumber: 7, projectRoot: missingWorktree }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["C"] },
            { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const startInput = JSON.stringify({ taskNumber: 7, worktree: missingWorktree, runId: "r1", projectRoot: missingWorktree });
    runHook(`/run-step A ${startInput}`, configFile);
    assert.equal(existsSync(checkpointPath(missingWorktree)), false);
});

test("test_runStepHook_keepsTheFailedBlockInTheCheckpointThroughTheFailureChain", () => {
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", next: FAILURES_EXIT_KEY, exitType: "tests-red", exitNote: "n", worktree, runId: "r1", taskNumber: 7, projectRoot: worktree }), next: [FAILURES_EXIT_KEY] },
        ],
        "pipeline-failuresExit.mmd": [
            { box: "FAILURES_EXIT", script: writeStep("FAILURES_EXIT", { scriptSignal: "continue" }), next: ["STOP"] },
            { box: "STOP", script: writeStep("STOP", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const startInput = JSON.stringify({ taskNumber: 7, worktree, runId: "r1", projectRoot: worktree });
    const { checkpoint } = runHook(`/run-step A ${startInput}`, configFile, worktree);
    assert.equal(checkpoint?.block, "one.mmd::A");
    assert.equal(checkpoint?.state, "failed");
    assert.equal(checkpoint?.exitType, "tests-red");
    assert.equal(checkpoint?.input, startInput);
});

// A run that starts at the preamble redirects to the checkpoint block instead of building a new worktree.
test("test_runStepHook_resumesAtTheCheckpointBlockWhenTheStartBlockIsThePreamble", () => {
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    const tasksFile = join(mkdtempSync(join(tmpdir(), "run-step-tasks-")), "tasks.json");
    writeFileSync(tasksFile, JSON.stringify([{
        taskNumber: 7,
        run: {
            active: true,
            worktree,
            leaseRunId: "r1",
            history: [{
                runId: "r1", startedAt: "t", endedAt: null, exitType: null, exitNote: null,
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }]));
    writeFileSync(`${worktree}.lease`, JSON.stringify({ pid: process.pid, runId: "r1" }));
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, "plans", "checkpoint.json"), JSON.stringify({
        taskNumber: 7, passId: "orig-pass", runId: "r1", projectRoot: dirname(tasksFile),
        block: "x.mmd::X", input: "", state: "running", sourceLockHeld: false,
        exitType: "", exitNote: "", resumedFrom: null,
    }));
    const configFile = configWith(writeStep => ({
        [PREAMBLE_DIAGRAM]: [{ box: PREAMBLE_BOX, script: writeStep(PREAMBLE_BOX, { scriptSignal: "stop" }), next: [] }],
        "x.mmd": [{ box: "X", script: writeStep("X", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook(`/run-step ${START_STEP} ${JSON.stringify({ taskNumber: 7, tasksFile })}`, configFile);
    assert.deepEqual(result.ran, ["x.mmd::X"]);
});

test("test_runStepHook_marksTheCheckpointResumedBeforeWalking", () => {
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    const tasksFile = join(mkdtempSync(join(tmpdir(), "run-step-tasks-")), "tasks.json");
    writeFileSync(tasksFile, JSON.stringify([{
        taskNumber: 7,
        run: {
            active: true,
            worktree,
            leaseRunId: "r1",
            history: [{
                runId: "r1", startedAt: "t", endedAt: null, exitType: null, exitNote: null,
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }]));
    writeFileSync(`${worktree}.lease`, JSON.stringify({ pid: process.pid, runId: "r1" }));
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, "plans", "checkpoint.json"), JSON.stringify({
        taskNumber: 7, passId: "orig-pass", runId: "r1", projectRoot: dirname(tasksFile),
        block: "x.mmd::X", input: "", state: "running", sourceLockHeld: false,
        exitType: "", exitNote: "", resumedFrom: null,
    }));
    const configFile = configWith(writeStep => ({
        [PREAMBLE_DIAGRAM]: [{ box: PREAMBLE_BOX, script: writeStep(PREAMBLE_BOX, { scriptSignal: "stop" }), next: [] }],
        "x.mmd": [{ box: "X", script: writeStep("X", { scriptSignal: "stop" }), next: [] }],
    }));
    const { checkpoint } = runHook(`/run-step ${START_STEP} ${JSON.stringify({ taskNumber: 7, tasksFile })}`, configFile, worktree);
    assert.equal(checkpoint?.state, "running");
    assert.equal(checkpoint?.resumedFrom?.block, "x.mmd::X");
});

test("test_runStepHook_carriesResumedFromThroughLaterWrites", () => {
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    const tasksFile = join(mkdtempSync(join(tmpdir(), "run-step-tasks-")), "tasks.json");
    writeFileSync(tasksFile, JSON.stringify([{
        taskNumber: 7,
        run: {
            active: true,
            worktree,
            leaseRunId: "r1",
            history: [{
                runId: "r1", startedAt: "t", endedAt: null, exitType: null, exitNote: null,
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }]));
    writeFileSync(`${worktree}.lease`, JSON.stringify({ pid: process.pid, runId: "r1" }));
    mkdirSync(join(worktree, "plans"), { recursive: true });
    const resumeInput = JSON.stringify({ worktree, runId: "r1", taskNumber: 7, projectRoot: dirname(tasksFile) });
    writeFileSync(join(worktree, "plans", "checkpoint.json"), JSON.stringify({
        taskNumber: 7, passId: "orig-pass", runId: "r1", projectRoot: dirname(tasksFile),
        block: "one.mmd::A", input: resumeInput, state: "failed", sourceLockHeld: false,
        exitType: "tests-red", exitNote: "n", resumedFrom: null,
    }));
    const configFile = configWith(writeStep => ({
        [PREAMBLE_DIAGRAM]: [{ box: PREAMBLE_BOX, script: writeStep(PREAMBLE_BOX, { scriptSignal: "stop" }), next: [] }],
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", worktree, runId: "r1", taskNumber: 7, projectRoot: dirname(tasksFile) }), next: ["A2"] },
            { box: "A2", script: writeStep("A2", { scriptSignal: "continue", worktree, runId: "r1", taskNumber: 7, projectRoot: dirname(tasksFile) }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["C"] },
            { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { checkpoint } = runHook(`/run-step ${START_STEP} ${JSON.stringify({ taskNumber: 7, tasksFile })}`, configFile, worktree);
    assert.equal(checkpoint?.block, "one.mmd::A2");
    assert.deepEqual(checkpoint?.resumedFrom, { block: "one.mmd::A", exitType: "tests-red", exitNote: "n" });
});

test("test_runStepHook_keepsThePassIdWhenItRerunsTheCheckpointBlock", () => {
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    const tasksFile = join(mkdtempSync(join(tmpdir(), "run-step-tasks-")), "tasks.json");
    writeFileSync(tasksFile, JSON.stringify([{
        taskNumber: 7,
        run: {
            active: true,
            worktree,
            leaseRunId: "r1",
            history: [{
                runId: "r1", startedAt: "t", endedAt: null, exitType: null, exitNote: null,
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }]));
    writeFileSync(`${worktree}.lease`, JSON.stringify({ pid: process.pid, runId: "r1" }));
    mkdirSync(join(worktree, "plans"), { recursive: true });
    const resumeInput = JSON.stringify({ worktree, runId: "r1", taskNumber: 7, projectRoot: dirname(tasksFile) });
    writeFileSync(join(worktree, "plans", "checkpoint.json"), JSON.stringify({
        taskNumber: 7, passId: "kept-pass-id", runId: "r1", projectRoot: dirname(tasksFile),
        block: "x.mmd::X", input: resumeInput, state: "running", sourceLockHeld: false,
        exitType: "", exitNote: "", resumedFrom: null,
    }));
    const configFile = configWith(writeStep => ({
        [PREAMBLE_DIAGRAM]: [{ box: PREAMBLE_BOX, script: writeStep(PREAMBLE_BOX, { scriptSignal: "stop" }), next: [] }],
        "x.mmd": [{ box: "X", script: writeStep("X", { scriptSignal: "stop" }), next: [] }],
    }));
    const { checkpoint } = runHook(`/run-step ${START_STEP} ${JSON.stringify({ taskNumber: 7, tasksFile })}`, configFile, worktree);
    assert.equal(checkpoint?.passId, "kept-pass-id");
});

// Reads its own just-written checkpoint at runtime so the test can see the passId a resumed block was actually given.
test("test_runStepHook_givesEveryNewBlockExecutionItsOwnPassId", () => {
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    const tasksFile = join(mkdtempSync(join(tmpdir(), "run-step-tasks-")), "tasks.json");
    writeFileSync(tasksFile, JSON.stringify([{
        taskNumber: 7,
        run: {
            active: true,
            worktree,
            leaseRunId: "r1",
            history: [{
                runId: "r1", startedAt: "t", endedAt: null, exitType: null, exitNote: null,
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
            }],
        },
    }]));
    writeFileSync(`${worktree}.lease`, JSON.stringify({ pid: process.pid, runId: "r1" }));
    mkdirSync(join(worktree, "plans"), { recursive: true });
    const resumeInput = JSON.stringify({ worktree, runId: "r1", taskNumber: 7, projectRoot: worktree });
    writeFileSync(join(worktree, "plans", "checkpoint.json"), JSON.stringify({
        taskNumber: 7, passId: "orig-pass-id", runId: "r1", projectRoot: dirname(tasksFile),
        block: "one.mmd::A", input: resumeInput, state: "running", sourceLockHeld: false,
        exitType: "", exitNote: "", resumedFrom: null,
    }));
    const checkpointFile = join(worktree, "plans", "checkpoint.json");
    const configFile = configWith(writeStep => {
        const aScript = writeStep("A", { scriptSignal: "continue", worktree, runId: "r1", taskNumber: 7, projectRoot: worktree });
        writeFileSync(aScript, [
            `import { readFileSync } from "node:fs";`,
            `const seenPassId = JSON.parse(readFileSync(${JSON.stringify(checkpointFile)}, "utf8")).passId;`,
            `console.log(JSON.stringify({ box: "A", scriptSignal: "continue", worktree: ${JSON.stringify(worktree)}, runId: "r1", taskNumber: 7, projectRoot: ${JSON.stringify(worktree)}, seenPassId, input: process.argv[2] ?? "" }));`,
        ].join("\n"));
        return {
            [PREAMBLE_DIAGRAM]: [{ box: PREAMBLE_BOX, script: writeStep(PREAMBLE_BOX, { scriptSignal: "stop" }), next: [] }],
            "one.mmd": [
                { box: "A", script: aScript, next: ["A2"] },
                { box: "A2", script: writeStep("A2", { scriptSignal: "continue", worktree, runId: "r1", taskNumber: 7, projectRoot: worktree }), next: ["B"] },
                { box: "B", script: writeStep("B", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["C"] },
                { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
            ],
        };
    });
    const { result, checkpoint } = runHook(`/run-step ${START_STEP} ${JSON.stringify({ taskNumber: 7, tasksFile })}`, configFile, worktree);
    // A2 echoes A's output under input, so A's seenPassId sits one level down in B's packet.
    const seenPassId = JSON.parse(JSON.parse(readFileSync(result.outcome.payload, "utf8")).input).seenPassId;
    assert.equal(seenPassId, "orig-pass-id");
    assert.notEqual(checkpoint?.passId, seenPassId);
});

test("test_runStepHook_startStepKeyMatchesTheWorkflowsStartStep", () => {
    const hookSource = readFileSync(HOOK, "utf8");
    const match = hookSource.match(/const START_STEP_KEY = "([^"]+)"/);
    assert.equal(match?.[1], START_STEP);
});

test("test_runStepHook_movesTheCheckpointToTheBlockAfterAPromptOnceItSucceeds", () => {
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", worktree, runId: "r1", taskNumber: 7, projectRoot: worktree }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["C"] },
            { box: "C", script: writeStep("C", { scriptSignal: "continue", worktree, runId: "r1", taskNumber: 7, projectRoot: worktree }), next: ["D"] },
            { box: "D", script: writeStep("D", { scriptSignal: "prompt", prompt: "answer again" }), producesPrompt: true, next: ["E"] },
            { box: "E", script: writeStep("E", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const startInput = JSON.stringify({ taskNumber: 7, worktree, runId: "r1", projectRoot: worktree });
    const first = runHook(`/run-step A ${startInput}`, configFile, worktree);
    const { checkpoint } = runHook(`/run-step one.mmd::C ${JSON.stringify({ packetFile: first.result.outcome.payload })}`, configFile, worktree);
    assert.equal(checkpoint?.block, "one.mmd::C");
    assert.equal(checkpoint?.state, "running");
    const { prompt: _prompt, startedAt: _startedAt, ...packetC } = JSON.parse(readFileSync(first.result.outcome.payload, "utf8"));
    assert.equal(checkpoint?.input, JSON.stringify(packetC));
});

// A launch that names a block after the preamble: an ended run whose worktree, plan, brief and logged block input all exist.
function seedAnEndedRunReadyToStartAtABlock(loggedInput: Record<string, unknown>) {
    const worktree = mkdtempSync(join(tmpdir(), "run-step-worktree-"));
    const tasksFile = join(mkdtempSync(join(tmpdir(), "run-step-tasks-")), "tasks.json");
    const projectRoot = dirname(tasksFile);
    mkdirSync(join(projectRoot, ".git"));
    writeFileSync(tasksFile, JSON.stringify([{
        taskNumber: 7,
        run: {
            active: false,
            worktree,
            leaseRunId: "r1",
            history: [{
                runId: "r1", startedAt: "t", endedAt: "t2", exitType: "tests-red", exitNote: "n",
                modifiedFiles: [], commits: [], implementationNotesFile: null, taskTests: null, fullSuite: null,
                attempts: { testFixes: 2 }, countedPasses: { testFixes: ["p1", "p2"] },
            }],
        },
    }]));
    writeFileSync(`${worktree}.lease`, JSON.stringify({ pid: process.pid, runId: "r1" }));
    mkdirSync(join(worktree, "plans"), { recursive: true });
    writeFileSync(join(worktree, "plans", "plan.json"), "{}");
    writeFileSync(join(worktree, "plans", "brief-7.md"), "brief");
    const payload = JSON.stringify({ ...loggedInput, taskNumber: 7, runId: "r1", projectRoot, worktree });
    const priorPacketCommand = `node --no-inspect /steps/X.ts '${payload}'`;
    return { worktree, tasksFile, projectRoot, payload, priorPacketCommand };
}

test("test_runStepHook_startsAtTheNamedBlockWithTheInputFromTheRunLog", () => {
    // The launch names X. X's state exists, so the walk starts at X with X's last logged input, the run is active again, and its counters are cleared.
    const seeded = seedAnEndedRunReadyToStartAtABlock({ box: "W", scriptSignal: "continue" });
    const configFile = configWith(writeStep => ({
        [PREAMBLE_DIAGRAM]: [{ box: PREAMBLE_BOX, script: writeStep(PREAMBLE_BOX, { scriptSignal: "stop" }), next: [] }],
        "x.mmd": [{ box: "X", script: writeStep("X", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook(`/run-step X ${JSON.stringify({ taskNumber: 7, tasksFile: seeded.tasksFile })}`, configFile, undefined, seeded.priorPacketCommand);
    assert.deepEqual(result.ran, ["x.mmd::X"]);
    assert.equal(JSON.parse(readFileSync(result.outcome.payload, "utf8")).input, seeded.payload);
    const run = JSON.parse(readFileSync(seeded.tasksFile, "utf8"))[0].run;
    assert.equal(run.active, true);
    assert.equal(run.history[0].attempts, undefined);
    assert.equal(run.history[0].countedPasses, undefined);
});

test("test_runStepHook_startsAtThePreambleWhenTheNamedBlockHasNoState", () => {
    // The launch names X, but the plan file is missing, so the hook ignores X and walks from the preamble.
    const seeded = seedAnEndedRunReadyToStartAtABlock({ box: "W", scriptSignal: "continue" });
    rmSync(join(seeded.worktree, "plans", "plan.json"));
    const configFile = configWith(writeStep => ({
        [PREAMBLE_DIAGRAM]: [{ box: PREAMBLE_BOX, script: writeStep(PREAMBLE_BOX, { scriptSignal: "stop" }), next: [] }],
        "x.mmd": [{ box: "X", script: writeStep("X", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook(`/run-step X ${JSON.stringify({ taskNumber: 7, tasksFile: seeded.tasksFile })}`, configFile, undefined, seeded.priorPacketCommand);
    assert.deepEqual(result.ran, [START_STEP]);
    assert.equal(JSON.parse(readFileSync(seeded.tasksFile, "utf8"))[0].run.active, false);
});

test("test_runStepHook_takesTheSourceLockWhenTheNamedBlockSitsInsideTheLock", () => {
    // X is reachable from LOCK_SOURCE_REPO, so starting at X takes the source lock for run r1 first.
    const seeded = seedAnEndedRunReadyToStartAtABlock({ box: "W", scriptSignal: "continue" });
    const configFile = configWith(writeStep => ({
        [PREAMBLE_DIAGRAM]: [{ box: PREAMBLE_BOX, script: writeStep(PREAMBLE_BOX, { scriptSignal: "stop" }), next: [] }],
        "pipeline-lockSourceRepo.mmd": [{ box: "LOCK_SOURCE_REPO", script: writeStep("LOCK_SOURCE_REPO", { scriptSignal: "continue" }), next: ["X"] }],
        "x.mmd": [{ box: "X", script: writeStep("X", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook(`/run-step X ${JSON.stringify({ taskNumber: 7, tasksFile: seeded.tasksFile })}`, configFile, undefined, seeded.priorPacketCommand);
    assert.deepEqual(result.ran, ["x.mmd::X"]);
    assert.equal(readSourceRepoLock(seeded.projectRoot)?.owner, buildLockOwner("r1", 7));
});

test("test_runStepHook_takesNoSourceLockForABlockInAnExitDiagram", () => {
    // X lives in the failures-exit diagram. The exit tails release the lock, so a start there takes none.
    const seeded = seedAnEndedRunReadyToStartAtABlock({ box: "W", scriptSignal: "continue" });
    const configFile = configWith(writeStep => ({
        [PREAMBLE_DIAGRAM]: [{ box: PREAMBLE_BOX, script: writeStep(PREAMBLE_BOX, { scriptSignal: "stop" }), next: [] }],
        "pipeline-lockSourceRepo.mmd": [{ box: "LOCK_SOURCE_REPO", script: writeStep("LOCK_SOURCE_REPO", { scriptSignal: "continue" }), next: ["X"] }],
        "pipeline-failuresExit.mmd": [{ box: "X", script: writeStep("X", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook(`/run-step X ${JSON.stringify({ taskNumber: 7, tasksFile: seeded.tasksFile })}`, configFile, undefined, seeded.priorPacketCommand);
    assert.deepEqual(result.ran, ["pipeline-failuresExit.mmd::X"]);
    assert.equal(readSourceRepoLock(seeded.projectRoot), null);
});
