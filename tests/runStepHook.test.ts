// Spawns the hook the way Claude Code does: one JSON payload on stdin, one JSON line on stdout.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const HOOK = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts/runStepHook.ts");

function runHook(prompt: string, configFile?: string) {
    const logFile = join(mkdtempSync(join(tmpdir(), "run-step-")), "run-log.md");
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }),
        encoding: "utf8",
        env: { ...process.env, RUN_STEP_LOG: logFile, ...(configFile ? { RUN_STEP_CONFIG: configFile } : {}) },
    });
    const injected = spawned.stdout.trim();
    const result = injected ? JSON.parse(JSON.parse(injected).hookSpecificOutput.additionalContext) : null;
    return { injected, result, readLog: () => readFileSync(logFile, "utf8") };
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
    assert.equal(JSON.parse(readFileSync(result.outcome.packetFile, "utf8")).from, "two");
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
    assert.equal(result.outcome.box, "one.mmd::C");
    assert.equal(result.outcome.scriptSignal, "stop");
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
    assert.equal(result.outcome.scriptSignal, "stop");
    assert.equal(result.outcome.workflowSignal, "done");
});

// A block that prints a prompt hands off to an agent, so the walk stops without ending the path.
test("test_runStepHook_stopsWhenABlockPrintsAPromptForAnAgent", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "prompt", prompt: "read the plan and answer" }), producesPrompt: true, next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, true);
    assert.equal(result.outcome.scriptSignal, "prompt");
    assert.equal(result.outcome.workflowSignal, "continue");
    assert.deepEqual(result.ran, ["one.mmd::A"]);
    assert.equal(result.outcome.payload.prompt, "read the plan and answer");
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
        writeFileSync(brokenScript, `console.log(JSON.stringify({ box: "A", scriptSignal: "stop", input: "", surprise: true }));\n`);
        writeStep("A", { scriptSignal: "stop", input: "" });
        return { "one.mmd": [{ box: "A", script: brokenScript, next: [] }] };
    });
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /one\.mmd::A output breaks its contract/);
    assert.match(result.errors[1], /surprise is not in the template/);
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

// The block after a prompt reads packet plus answer, so the hook returns the packet the prompt block received.
test("test_runStepHook_stopsBeforeAPromptBlockAndHandsItsOutputAsThePacket", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", taskNumber: 7, runId: "run-1" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "prompt", prompt: "answer" }), producesPrompt: true, next: ["C"] },
            { box: "C", script: writeStep("C", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.deepEqual(result.ran, ["one.mmd::A"]);
    assert.equal(result.outcome.scriptSignal, "continue");
    assert.equal(result.outcome.next, "one.mmd::B");
    assert.equal("packet" in result.outcome, false);
    assert.deepEqual(JSON.parse(readFileSync(result.outcome.packetFile, "utf8")), { box: "A", scriptSignal: "continue", taskNumber: 7, runId: "run-1", input: "" });
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
    assert.equal(result.outcome.scriptSignal, "prompt");
    assert.equal("packet" in result.outcome, false);
    assert.deepEqual(JSON.parse(readFileSync(result.outcome.packetFile, "utf8")), { box: "A", scriptSignal: "continue", taskNumber: 7 });
});

// After a stop block the packet is that block's whole output, box and scriptSignal included.
test("test_runStepHook_handsAStopBlocksOutputAsThePacket", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook("/run-step A just words", configFile);
    assert.equal("packet" in result.outcome, false);
    assert.deepEqual(JSON.parse(readFileSync(result.outcome.packetFile, "utf8")), { box: "A", scriptSignal: "stop", input: "just words" });
});

// A start input naming a packetFile expands to that file's contents plus the fields alongside it.
test("test_runStepHook_expandsAPacketFileIntoTheStartInput", () => {
    const folder = mkdtempSync(join(tmpdir(), "run-step-packet-"));
    const packetFile = join(folder, "task-packet.json");
    writeFileSync(packetFile, JSON.stringify({ taskNumber: 7 }));
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook(`/run-step A {"packetFile":"${packetFile}","answer":"x"}`, configFile);
    const startInput = JSON.parse(JSON.parse(readFileSync(result.outcome.packetFile, "utf8")).input);
    assert.equal(startInput.taskNumber, 7);
    assert.equal(startInput.answer, "x");
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
    assert.match(log, /### === command ======\nnode --no-inspect .*A\.ts\n### end command ======/);
    assert.match(log, /### command output ======\n```json\n\{"box":"A","scriptSignal":"continue","input":""\}\n```\n### end command output ======/);
    assert.match(log, /### output ======\n```json\n\{\n    "ok": true,\n/);
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
    assert.equal(JSON.parse(readFileSync(result.outcome.packetFile, "utf8")).input, `{"name":"matt"}`);
});

test("test_runStepHook_givesTheFirstBlockAnEmptyInputWhenTheLineHasNone", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(JSON.parse(readFileSync(result.outcome.packetFile, "utf8")).input, "");
});

test("test_runStepHook_logsTheInputAsPartOfThePasteableCommand", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { scriptSignal: "stop" }), next: [] }],
    }));
    const log = runHook(`/run-step A it's here`, configFile).readLog();
    assert.match(log, /### === command ======\nnode --no-inspect .*A\.ts 'it'\\''s here'\n### end command ======/);
});

test("test_runStepHook_handsOneBlocksOutputToTheNextBlock", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue", greeting: "hello" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A first-input", configFile);
    const received = JSON.parse(JSON.parse(readFileSync(result.outcome.packetFile, "utf8")).input);
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
    const seenByC = JSON.parse(JSON.parse(readFileSync(result.outcome.packetFile, "utf8")).input);
    assert.equal(seenByC.box, "B");
    assert.equal(JSON.parse(seenByC.input).box, "A");
});

test("test_runStepHook_logsTheThreadedOutputAsThePasteableCommand", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { scriptSignal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { scriptSignal: "stop" }), next: [] },
        ],
    }));
    const log = runHook("/run-step A", configFile).readLog();
    assert.match(log, /node --no-inspect .*B\.ts '\{"box":"A","scriptSignal":"continue","input":""\}'/);
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
    const result = injected ? JSON.parse(JSON.parse(injected).hookSpecificOutput.additionalContext) : null;
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
    assert.equal(JSON.parse(readFileSync(result.outcome.packetFile, "utf8")).input, `{"name":"matt"}`);
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
