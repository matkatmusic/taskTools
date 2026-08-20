// Runs one diagram block for /run-step, typed as a prompt so it fires inside a workflow subagent.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// The override exists so a test writes to its own temp log instead of the run's.
const LOG_FILE = process.env.RUN_STEP_LOG ?? join(PROJECT_ROOT, "plans/diagrams/runs/run-log.md");
const CONFIG_FILE = process.env.RUN_STEP_CONFIG ?? join(PROJECT_ROOT, "scripts/steps.json");

type StepConfigEntry = { box: string; script: string; next: string[] };
type StepConfig = Record<string, StepConfigEntry[]>;
type Step = StepConfigEntry & { diagram: string };

// Every diagram's boxes in one map, keyed "diagram.mmd::BOX", so a seam is a plain lookup.
const STEPS = new Map<string, Step>();
for (const [diagram, entries] of Object.entries(JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StepConfig)) {
    for (const entry of entries) STEPS.set(`${diagram}::${entry.box}`, { ...entry, diagram });
}

// A bare box id names its own diagram; one with :: names another.
function keyFor(reference: string, fromDiagram: string): string {
    return reference.includes("::") ? reference : `${fromDiagram}::${reference}`;
}

function keysNamingBox(box: string): string[] {
    return [...STEPS.keys()].filter(key => key.slice(key.indexOf("::") + 2) === box);
}

const FENCE = "=".repeat(36);

function logStepOutput(blockId: string, invocation: string, command: string, commandOutput: string, output: unknown): void {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    const block = `${"=".repeat(7)} ${blockId} ${"=".repeat(6)}\n`
        + `Source ${CONFIG_FILE === join(PROJECT_ROOT, "scripts/steps.json") ? "scripts/steps.json" : CONFIG_FILE}: ${blockId}\n`
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

type StepRun = { ok: boolean; box: string; command: string; exitCode: number | null; stdout: string; result: Record<string, unknown> | null };

// Single quotes for the log line only: the spawn itself passes an argument list, never a shell string.
function shellQuoted(argument: string): string {
    return `'${argument.replaceAll("'", `'\\''`)}'`;
}

function runOneStep(step: Step, input: string, invocation: string): StepRun {
    const argv = input ? ["--no-inspect", step.script, input] : ["--no-inspect", step.script];
    // Logged whole so the line in run-log.md is one you can paste into a terminal.
    const command = `node --no-inspect ${step.script}${input ? ` ${shellQuoted(input)}` : ""}`;
    const spawned = spawnSync("node", argv, { cwd: PROJECT_ROOT, encoding: "utf8" });
    const stdout = `${spawned.stdout ?? ""}${spawned.stderr ?? ""}`.trimEnd();
    let result: Record<string, unknown> | null = null;
    try {
        result = JSON.parse(stdout.split("\n").at(-1) ?? "");
    } catch {
        result = null;
    }
    const run = { ok: spawned.status === 0, box: step.box, command, exitCode: spawned.status, stdout, result };
    logStepOutput(step.box, invocation, command, stdout, run);
    return run;
}

// Runs a step, then keeps going while the graph names exactly one next box and the step says continue.
function walkFrom(startKey: string, startInput: string, invocation: string): Record<string, unknown> {
    const ran: string[] = [];
    let key = startKey;
    let input = startInput;
    while (true) {
        const step = STEPS.get(key)!;
        const run = runOneStep(step, input, invocation);
        ran.push(key);
        if (!run.ok) return { ok: false, ran, stoppedAt: key, why: `exited ${run.exitCode}`, output: run.stdout };
        if (!run.result) return { ok: false, ran, stoppedAt: key, why: "printed no result object", output: run.stdout };
        const signal = run.result.signal;
        if (signal !== "stop" && signal !== "continue") return { ok: false, ran, stoppedAt: key, why: `signal must be "stop" or "continue", not ${JSON.stringify(signal)}`, output: run.result };
        if (signal === "stop") return { ok: true, ran, stoppedAt: key, why: "signal stop", output: run.result };
        if (step.next.length === 0) return { ok: false, ran, stoppedAt: key, why: `${key} has an empty next; say where it goes next in steps.json`, output: run.result };
        // A box with one successor may leave next out of its output; a decision box must name its choice.
        const chosen = run.result.next ?? (step.next.length === 1 ? step.next[0] : undefined);
        if (chosen === undefined) return { ok: false, ran, stoppedAt: key, why: `${key} points at ${step.next.join(", ")}; its output must name one in next`, output: run.result };
        if (!step.next.includes(String(chosen))) return { ok: false, ran, stoppedAt: key, why: `next ${JSON.stringify(chosen)} is not one of ${step.next.join(", ")}`, output: run.result };
        const nextKey = keyFor(String(chosen), step.diagram);
        if (!STEPS.has(nextKey)) return { ok: false, ran, stoppedAt: key, why: `next box ${nextKey} is not in the config`, output: run.result };
        key = nextKey;
        // Only the first box gets the caller's input; what a later box receives is task #2.
        input = "";
    }
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
// The first word after the command names the box; everything after it is the first box's input.
const [, quotedBlockId = "", startInput = ""] = invocation.slice("/run-step".length).trim().match(/^("[^"]*"|'[^']*'|\S+)\s*([\s\S]*)$/) ?? [];
const blockId = quotedBlockId.replace(/^(["'])(.*)\1$/s, "$2");
const startKeys = blockId.includes("::") ? [blockId].filter(key => STEPS.has(key)) : keysNamingBox(blockId);

if (startKeys.length === 0) {
    inject(JSON.stringify({ ok: false, blockId, why: `no block named ${blockId || "<missing>"}; known: ${[...STEPS.keys()].join(", ")}` }));
    process.exit(0);
}
if (startKeys.length > 1) {
    inject(JSON.stringify({ ok: false, blockId, why: `${blockId} is named by more than one diagram: ${startKeys.join(", ")}; start it as diagram.mmd::${blockId}` }));
    process.exit(0);
}

inject(JSON.stringify(walkFrom(startKeys[0]!, startInput.trim(), invocation)));
