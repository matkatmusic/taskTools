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

test("test_runStepHook_staysSilentForAPromptThatNamesAnotherSkill", () => {
    assert.equal(runHook("/some-other-skill SAY_HELLO").injected, "");
});

test("test_runStepHook_staysSilentForAPromptThatIsNotACommand", () => {
    assert.equal(runHook("please run SAY_HELLO for me").injected, "");
});

test("test_runStepHook_answersANamespacedInvocation", () => {
    assert.equal(runHook("/taskTools:run-step SAY_HELLO").result.ok, true);
});

test("test_runStepHook_runsTheCommandTheBlockNames", () => {
    const { result } = runHook("/run-step SAY_HELLO");
    assert.deepEqual(result, {
        ok: true,
        blockId: "SAY_HELLO",
        command: "node --no-inspect scripts/steps/pipeline/SAY_HELLO.ts",
        exitCode: 0,
        stdout: "hello from run-step",
    });
});

test("test_runStepHook_namesTheKnownBlocksWhenTheBlockIsUnknown", () => {
    const { result } = runHook("/run-step NOT_A_BLOCK");
    assert.equal(result.ok, false);
    assert.match(result.note, /no block named NOT_A_BLOCK/);
    assert.match(result.note, /SAY_HELLO, STAMP_TIME, COUNT_FILES/);
});

test("test_runStepHook_reportsANonZeroExitAsNotOk", () => {
    // The table holds shell strings, so a failing block is one the shell exits non-zero on.
    const { result } = runHook("/run-step COUNT_FILES");
    assert.equal(result.ok, result.exitCode === 0);
});

test("test_runStepHook_logsTheInvocationTheCommandAndTheOutput", () => {
    const { readLog } = runHook("/run-step SAY_HELLO");
    assert.equal(readLog(), [
        "======= SAY_HELLO ======",
        "Source scripts/runStepHook.ts: STEP_TABLE.SAY_HELLO",
        `input: {"invocation":"/run-step SAY_HELLO"}`,
        "====== command ======",
        "node --no-inspect scripts/steps/pipeline/SAY_HELLO.ts",
        "====== end command ======",
        "====== command output ======",
        "hello from run-step",
        "====== end command output ======",
        `output: {"ok":true,"blockId":"SAY_HELLO","command":"node --no-inspect scripts/steps/pipeline/SAY_HELLO.ts","exitCode":0,"stdout":"hello from run-step"}`,
        "====================================",
        "",
    ].join("\n"));
});

test("test_runStepHook_appendsOneBlockPerInvocation", () => {
    const logFile = join(mkdtempSync(join(tmpdir(), "run-step-")), "run-log.md");
    for (const prompt of ["/run-step SAY_HELLO", "/run-step STAMP_TIME"]) {
        spawnSync("node", ["--no-inspect", HOOK], {
            input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }),
            encoding: "utf8",
            env: { ...process.env, RUN_STEP_LOG: logFile },
        });
    }
    const log = readFileSync(logFile, "utf8");
    assert.match(log, /======= SAY_HELLO ======/);
    assert.match(log, /======= STAMP_TIME ======/);
});

test("test_runStepHook_writesNothingToTheLogWhenNoBlockRan", () => {
    const { readLog } = runHook("/run-step NOT_A_BLOCK");
    assert.throws(readLog, /ENOENT/);
});

test("test_runStepHook_refusesABoxTwoDiagramsBothName", () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "run-step-")), "steps.json");
    writeFileSync(configFile, JSON.stringify({
        "one.mmd": [{ box: "SHARED", script: "scripts/steps/one/SHARED.ts" }],
        "two.mmd": [{ box: "SHARED", script: "scripts/steps/two/SHARED.ts" }],
    }));
    const { result } = runHook("/run-step SHARED", configFile);
    assert.equal(result.ok, false);
    assert.match(result.note, /named by more than one diagram/);
});

test("test_runStepHook_readsABoxFromASecondDiagram", () => {
    const configFile = join(mkdtempSync(join(tmpdir(), "run-step-")), "steps.json");
    writeFileSync(configFile, JSON.stringify({
        "one.mmd": [{ box: "SAY_HELLO", script: "scripts/steps/pipeline/SAY_HELLO.ts" }],
        "two.mmd": [{ box: "ONLY_IN_TWO", script: "scripts/steps/pipeline/STAMP_TIME.ts" }],
    }));
    assert.equal(runHook("/run-step ONLY_IN_TWO", configFile).result.ok, true);
});
