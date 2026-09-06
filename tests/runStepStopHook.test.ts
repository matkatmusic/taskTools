// Spawns the SubagentStop hook the way Claude Code does: one JSON payload on stdin, one JSON line on stdout.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const HOOK = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts/hooks/runStepStopHook.ts");

// One block B whose input wants message and additionalData, a packet file, and a transcript naming both.
function buildAgent(packet: Record<string, unknown>, hookOutputInTranscript = true) {
    const folder = mkdtempSync(join(tmpdir(), "run-step-stop-"));
    const templateFile = join(folder, "B.template.json");
    writeFileSync(templateFile, JSON.stringify({ input: { taskNumber: 0, message: "", additionalData: {} }, output: { box: "B", scriptSignal: "stop" } }));
    const configFile = join(folder, "steps.json");
    writeFileSync(configFile, JSON.stringify({ "one.mmd": [{ box: "B", script: "B.ts", template: templateFile, producesPrompt: false, next: [] }] }));
    const packetFile = join(folder, "A-1.json");
    writeFileSync(packetFile, JSON.stringify(packet));
    const hookOutput = JSON.stringify({ ok: true, ran: ["one.mmd::A"], errors: [], outcome: { next: "one.mmd::B", payload: packetFile } });
    const transcriptFile = join(folder, "agent-1.jsonl");
    const lines = hookOutputInTranscript ? [JSON.stringify({ type: "user", content: `${hookOutput}\nRead that file.` })] : [JSON.stringify({ type: "user", content: "hello" })];
    writeFileSync(transcriptFile, `${lines.join("\n")}\n`);
    return { configFile, packetFile, transcriptFile };
}

function runStopHook(transcriptFile: string, configFile: string) {
    const logFile = join(mkdtempSync(join(tmpdir(), "run-step-stop-log-")), "run-log.json");
    const spawned = spawnSync("node", ["--no-inspect", HOOK], {
        input: JSON.stringify({ hook_event_name: "SubagentStop", agent_transcript_path: transcriptFile }),
        encoding: "utf8",
        env: { ...process.env, RUN_STEP_CONFIG: configFile, RUN_STEP_LOG: logFile },
    });
    return { stdout: spawned.stdout.trim(), stderr: spawned.stderr, status: spawned.status, readLog: () => readFileSync(logFile, "utf8") };
}

test("test_runStepStopHook_staysSilentForAnAgentThatNeverRanAStep", () => {
    const { configFile, transcriptFile } = buildAgent({ taskNumber: 7, prompt: "answer" }, false);
    const { stdout, stderr, status, readLog } = runStopHook(transcriptFile, configFile);
    assert.deepEqual({ stdout, stderr, status }, { stdout: "", stderr: "", status: 0 });
    assert.match(readLog(), /nothing to check/);
});

// The prompt was answered into the file, so the next block's input contract holds and the agent may stop.
test("test_runStepStopHook_staysSilentWhenTheAnswerIsInThePacketFile", () => {
    const { configFile, packetFile, transcriptFile } = buildAgent({ taskNumber: 7, prompt: "answer", message: "", additionalData: { planFile: "x" } });
    const { stdout, stderr, status, readLog } = runStopHook(transcriptFile, configFile);
    assert.deepEqual({ stdout, stderr, status }, { stdout: "", stderr: "", status: 0 });
    assert.match(readLog(), new RegExp(`${packetFile} is ready for one\\.mmd::B`));
});

// The agent returned the hook output without doing the work, so it is sent back to the file.
test("test_runStepStopHook_blocksTheStopWhenTheAnswerIsMissingFromThePacketFile", () => {
    const { configFile, packetFile, transcriptFile } = buildAgent({ taskNumber: 7, prompt: "answer" });
    const { stdout, readLog } = runStopHook(transcriptFile, configFile);
    const decision = JSON.parse(stdout);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, new RegExp(`^${packetFile} is not ready for one\\.mmd::B: message is missing; additionalData is missing\\.`));
    assert.match(decision.reason, /write your answer by piping it on stdin to: node \S+\/writeAgentAnswer\.ts /);
    assert.match(readLog(), /blocked the stop: /);
});

// Every invocation leaves a line, so a run shows the hook fired, even when it says nothing.
test("test_runStepStopHook_logsEveryTimeItFires", () => {
    const { configFile, transcriptFile } = buildAgent({ taskNumber: 7, prompt: "answer" }, false);
    // The log file is one JSON array; its first entry is the "fired" note of this invocation.
    const entries = JSON.parse(runStopHook(transcriptFile, configFile).readLog());
    assert.equal(entries[0].block, "STOP HOOK");
    assert.equal(entries[0].note, `fired for "${transcriptFile}"`);
});
