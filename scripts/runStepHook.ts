// Runs one diagram block for /run-step, typed as a prompt so it fires inside a workflow subagent.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// The override exists so a test writes to its own temp log instead of the run's.
const LOG_FILE = process.env.RUN_STEP_LOG ?? join(PROJECT_ROOT, "plans/diagrams/runs/run-log.md");

// Keyed by the box ids drawn in plans/diagrams/pipeline.mmd.
const STEP_TABLE: Record<string, string> = {
    SAY_HELLO: "echo hello from run-step",
    STAMP_TIME: "date -u +%Y-%m-%dT%H:%M:%SZ",
    COUNT_FILES: "git ls-files | wc -l",
};

const FENCE = "=".repeat(36);

function logStepOutput(blockId: string, invocation: string, command: string, commandOutput: string, output: unknown): void {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    const block = `${"=".repeat(7)} ${blockId} ${"=".repeat(6)}\n`
        + `Source scripts/runStepHook.ts: STEP_TABLE.${blockId}\n`
        + `input: ${JSON.stringify({ invocation })}\n`
        + `====== command ======\n`
        + `${command}\n`
        + `====== end command ======\n`
        + `====== command output ======\n`
        + `${commandOutput}\n`
        + `====== end command output ======\n`
        + `output: ${JSON.stringify(output)}\n`
        + `${FENCE}\n`;
    // One write, one string: many processes append to this file concurrently.
    appendFileSync(LOG_FILE, block);
}

let payload: { hook_event_name?: unknown; prompt?: unknown };
try {
    payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
    process.exit(0);
}

// Plugin skills reach the hook namespaced, as /taskTools:run-step.
const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
if (!prompt.startsWith("/run-step")) process.exit(0);

const inject = (reason: string) => process.stdout.write(JSON.stringify({
    // Echoed from the payload: a name that disagrees with the firing event gets the output dropped.
    hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: reason },
}) + "\n");

const invocation = prompt.trim();
const blockId = (invocation.slice("/run-step".length).match(/"[^"]*"|'[^']*'|\S+/) ?? [""])[0].replace(/^(["'])(.*)\1$/s, "$2");
const command = STEP_TABLE[blockId];
if (!command) {
    inject(JSON.stringify({ ok: false, blockId, note: `run-step: no block named ${blockId || "<missing>"}; known: ${Object.keys(STEP_TABLE).join(", ")}` }));
    process.exit(0);
}

const run = spawnSync(command, { cwd: PROJECT_ROOT, shell: true, encoding: "utf8" });
const commandOutput = `${run.stdout ?? ""}${run.stderr ?? ""}`.trimEnd();
const result = { ok: run.status === 0, blockId, command, exitCode: run.status, stdout: commandOutput };
logStepOutput(blockId, invocation, command, commandOutput, result);
inject(JSON.stringify(result));
