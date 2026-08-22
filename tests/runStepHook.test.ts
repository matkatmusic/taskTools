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
function configWith(build: (writeStep: (box: string, result: Record<string, unknown>) => string, folder: string) => Record<string, { box: string; script: string; next: string[] }[]>) {
    const folder = mkdtempSync(join(tmpdir(), "run-step-steps-"));
    const writeStep = (box: string, result: Record<string, unknown>) => {
        const scriptPath = join(folder, `${box}.ts`);
        writeFileSync(scriptPath, `console.log(JSON.stringify({ ...${JSON.stringify({ box, ...result })}, input: process.argv[2] ?? "" }));\n`);
        return scriptPath;
    };
    const configFile = join(folder, "steps.json");
    writeFileSync(configFile, JSON.stringify(build(writeStep, folder)));
    return configFile;
}

test("test_runStepHook_staysSilentForAPromptThatNamesAnotherSkill", () => {
    assert.equal(runHook("/some-other-skill SAY_HELLO").injected, "");
});

test("test_runStepHook_staysSilentForAPromptThatIsNotACommand", () => {
    assert.equal(runHook("please run SAY_HELLO for me").injected, "");
});

test("test_runStepHook_answersANamespacedInvocation", () => {
    assert.equal(runHook("/taskTools:run-step SAY_HELLO").result.ok, true);
});

test("test_runStepHook_namesTheKnownBlocksWhenTheBlockIsUnknown", () => {
    const { result } = runHook("/run-step NOT_A_BLOCK");
    assert.equal(result.ok, false);
    assert.match(result.why, /no block named NOT_A_BLOCK/);
    assert.match(result.why, /pipeline\.mmd::SAY_HELLO/);
});

test("test_runStepHook_refusesABareBoxTwoDiagramsBothName", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "SHARED", script: writeStep("SHARED", { signal: "stop" }), next: [] }],
        "two.mmd": [{ box: "SHARED", script: writeStep("SHARED", { signal: "stop" }), next: [] }],
    }));
    const { result } = runHook("/run-step SHARED", configFile);
    assert.equal(result.ok, false);
    assert.match(result.why, /named by more than one diagram/);
});

test("test_runStepHook_startsAtABoxNamedWithItsDiagram", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "SHARED", script: writeStep("ONE", { signal: "stop", from: "one" }), next: [] }],
        "two.mmd": [{ box: "SHARED", script: writeStep("TWO", { signal: "stop", from: "two" }), next: [] }],
    }));
    assert.equal(runHook("/run-step two.mmd::SHARED", configFile).result.output.from, "two");
});

test("test_runStepHook_walksUntilAStepSignalsStop", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { signal: "continue" }), next: ["C"] },
            { box: "C", script: writeStep("C", { signal: "stop", why: "an agent takes over" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.deepEqual(result.ran, ["one.mmd::A", "one.mmd::B", "one.mmd::C"]);
    assert.equal(result.stoppedAt, "one.mmd::C");
    assert.equal(result.why, "signal stop");
});

test("test_runStepHook_walksAcrossASeamIntoAnotherDiagram", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "HANDOFF", script: writeStep("HANDOFF", { signal: "continue" }), next: ["two.mmd::SWEEP"] }],
        "two.mmd": [{ box: "SWEEP", script: writeStep("SWEEP", { signal: "stop" }), next: [] }],
    }));
    assert.deepEqual(runHook("/run-step HANDOFF", configFile).result.ran, ["one.mmd::HANDOFF", "two.mmd::SWEEP"]);
});

test("test_runStepHook_failsWhenABoxThatWantsToContinueHasAnEmptyNext", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "continue" }), next: [] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.why, /one\.mmd::A has an empty next; say where it goes next/);
});

test("test_runStepHook_endsCleanlyWhenATerminalBoxSignalsStop", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop" }), next: [] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, true);
    assert.equal(result.why, "signal stop");
});

// A box with no arrow out of it ends a path, so a walk that reaches it ran the whole path.
test("test_runStepHook_marksATerminalBoxAsTheEndOfThePath", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { signal: "stop" }), next: [] },
        ],
    }));
    assert.equal(runHook("/run-step A", configFile).result.isTerminal, true);
    assert.equal(runHook("/run-step B", configFile).result.isTerminal, true);
});

test("test_runStepHook_doesNotMarkABoxWithAnArrowOutAsTheEndOfThePath", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop" }), next: ["B"] }],
    }));
    assert.equal(runHook("/run-step A", configFile).result.isTerminal, false);
});

// A block that prints a prompt hands the run to an agent, so the walk stops without ending the path.
test("test_runStepHook_stopsWhenABlockPrintsAPromptForAnAgent", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "prompt", prompt: "read the plan and answer" }), next: ["B"] },
            { box: "B", script: writeStep("B", { signal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, true);
    assert.equal(result.why, "signal prompt");
    assert.equal(result.isTerminal, false);
    assert.deepEqual(result.ran, ["one.mmd::A"]);
    assert.equal(result.output.prompt, "read the plan and answer");
});

// The workflow reads nextStep instead of keeping its own copy of the arrows.
test("test_runStepHook_namesTheStepThatFollowsTheOneItStoppedAt", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "prompt" }), next: ["B"] },
            { box: "B", script: writeStep("B", { signal: "stop" }), next: [] },
        ],
    }));
    assert.equal(runHook("/run-step A", configFile).result.nextStep, "one.mmd::B");
});

test("test_runStepHook_namesTheBranchTheBlockChoseAsTheNextStep", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "prompt", next: "C" }), next: ["B", "C"] },
            { box: "B", script: writeStep("B", { signal: "stop" }), next: [] },
            { box: "C", script: writeStep("C", { signal: "stop" }), next: [] },
        ],
    }));
    assert.equal(runHook("/run-step A", configFile).result.nextStep, "one.mmd::C");
});

test("test_runStepHook_leavesTheNextStepEmptyAtTheEndOfAPath", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop" }), next: [] }],
    }));
    assert.equal(runHook("/run-step A", configFile).result.nextStep, "");
});

test("test_runStepHook_carriesUpTheReportABlockWroteForTheUser", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop", report: "two plans need review" }), next: [] }],
    }));
    assert.equal(runHook("/run-step A", configFile).result.report, "two plans need review");
});

test("test_runStepHook_leavesTheReportEmptyWhenNoBlockWroteOne", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop" }), next: [] }],
    }));
    assert.equal(runHook("/run-step A", configFile).result.report, "");
});

test("test_runStepHook_failsWhenTheSignalIsNotOneOfTheThree", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "maybe" }), next: [] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.why, /signal must be one of "continue", "stop", "prompt", not "maybe"/);
});

test("test_runStepHook_failsWhenADecisionBoxDoesNotNameItsChoice", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "continue" }), next: ["B", "C"] },
            { box: "B", script: writeStep("B", { signal: "stop" }), next: [] },
            { box: "C", script: writeStep("C", { signal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.deepEqual(result.ran, ["one.mmd::A"]);
    assert.match(result.why, /points at B, C; its output must name one in next/);
});

test("test_runStepHook_takesTheBranchTheOutputNames", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "continue", next: "C" }), next: ["B", "C"] },
            { box: "B", script: writeStep("B", { signal: "stop" }), next: [] },
            { box: "C", script: writeStep("C", { signal: "stop" }), next: [] },
        ],
    }));
    assert.deepEqual(runHook("/run-step A", configFile).result.ran, ["one.mmd::A", "one.mmd::C"]);
});

test("test_runStepHook_failsWhenTheChosenBranchIsNotInNext", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "continue", next: "ELSEWHERE" }), next: ["B"] },
            { box: "B", script: writeStep("B", { signal: "stop" }), next: [] },
        ],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.why, /next "ELSEWHERE" is not one of B/);
});

test("test_runStepHook_stopsWhenTheNextBoxIsNotInTheConfig", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "continue" }), next: ["gone.mmd::MISSING"] }],
    }));
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.match(result.why, /gone\.mmd::MISSING is not in the config/);
});

test("test_runStepHook_stopsWhenAStepPrintsNoResultObject", () => {
    const configFile = configWith((_writeStep, folder) => {
        const scriptPath = join(folder, "A.ts");
        writeFileSync(scriptPath, `console.log("just words");\n`);
        return { "one.mmd": [{ box: "A", script: scriptPath, next: [] }] };
    });
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.equal(result.why, "printed no result object");
});

test("test_runStepHook_stopsWhenAStepExitsNonZero", () => {
    const configFile = configWith((_writeStep, folder) => {
        const scriptPath = join(folder, "A.ts");
        writeFileSync(scriptPath, `process.exit(3);\n`);
        return { "one.mmd": [{ box: "A", script: scriptPath, next: [] }] };
    });
    const { result } = runHook("/run-step A", configFile);
    assert.equal(result.ok, false);
    assert.equal(result.why, "exited 3");
});

test("test_runStepHook_logsOneBlockForEveryStepItRan", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { signal: "stop" }), next: [] },
        ],
    }));
    const log = runHook("/run-step A", configFile).readLog();
    assert.match(log, /======= A ======[\s\S]*======= B ======/);
    assert.match(log, /====== command ======\nnode --no-inspect .*A\.ts\n====== end command ======/);
    assert.match(log, /====== command output ======\n\{"box":"A","signal":"continue","input":""\}\n====== end command output ======/);
});

test("test_runStepHook_writesNothingToTheLogWhenNoBlockRan", () => {
    const { readLog } = runHook("/run-step NOT_A_BLOCK");
    assert.throws(readLog, /ENOENT/);
});

test("test_runStepHook_handsTheRestOfTheLineToTheFirstBlock", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop" }), next: [] }],
    }));
    assert.equal(runHook(`/run-step A {"name":"matt"}`, configFile).result.output.input, `{"name":"matt"}`);
});

test("test_runStepHook_givesTheFirstBlockAnEmptyInputWhenTheLineHasNone", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop" }), next: [] }],
    }));
    assert.equal(runHook("/run-step A", configFile).result.output.input, "");
});

test("test_runStepHook_logsTheInputAsPartOfThePasteableCommand", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop" }), next: [] }],
    }));
    const log = runHook(`/run-step A it's here`, configFile).readLog();
    assert.match(log, /====== command ======\nnode --no-inspect .*A\.ts 'it'\\''s here'\n====== end command ======/);
});

test("test_runStepHook_handsOneBlocksOutputToTheNextBlock", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "continue", greeting: "hello" }), next: ["B"] },
            { box: "B", script: writeStep("B", { signal: "stop" }), next: [] },
        ],
    }));
    const received = JSON.parse(runHook("/run-step A first-input", configFile).result.output.input);
    assert.equal(received.box, "A");
    assert.equal(received.greeting, "hello");
    assert.equal(received.input, "first-input");
});

test("test_runStepHook_threadsOutputThroughEveryHopOfAWalk", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { signal: "continue" }), next: ["C"] },
            { box: "C", script: writeStep("C", { signal: "stop" }), next: [] },
        ],
    }));
    const seenByC = JSON.parse(runHook("/run-step A", configFile).result.output.input);
    assert.equal(seenByC.box, "B");
    assert.equal(JSON.parse(seenByC.input).box, "A");
});

test("test_runStepHook_logsTheThreadedOutputAsThePasteableCommand", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [
            { box: "A", script: writeStep("A", { signal: "continue" }), next: ["B"] },
            { box: "B", script: writeStep("B", { signal: "stop" }), next: [] },
        ],
    }));
    const log = runHook("/run-step A", configFile).readLog();
    assert.match(log, /node --no-inspect .*B\.ts '\{"box":"A","signal":"continue","input":""\}'/);
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
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop" }), next: [] }],
    }));
    assert.equal(runSkillHook("run-step", "A", configFile).result.ok, true);
});

test("test_runStepHook_runsABlockWhenAnAgentCallsTheSkillNamespaced", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop" }), next: [] }],
    }));
    assert.equal(runSkillHook("taskTools:run-step", "A", configFile).result.ok, true);
});

test("test_runStepHook_staysSilentWhenAnAgentCallsAnotherSkill", () => {
    assert.equal(runSkillHook("some-other-skill", "A").injected, "");
});

test("test_runStepHook_handsTheSkillArgsToTheFirstBlock", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop" }), next: [] }],
    }));
    assert.equal(runSkillHook("run-step", `A {"name":"matt"}`, configFile).result.output.input, `{"name":"matt"}`);
});

test("test_runStepHook_echoesPostToolUseAsTheHookEventName", () => {
    const configFile = configWith(writeStep => ({
        "one.mmd": [{ box: "A", script: writeStep("A", { signal: "stop" }), next: [] }],
    }));
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "run-step", args: "A" } }),
        encoding: "utf8",
        env: { ...process.env, RUN_STEP_CONFIG: configFile },
    });
    assert.equal(JSON.parse(spawned.stdout.trim()).hookSpecificOutput.hookEventName, "PostToolUse");
});
