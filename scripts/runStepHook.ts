// Runs one diagram block for /run-step, typed as a prompt so it fires inside a workflow subagent.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_SIGNALS, SIGNAL, type Signal } from "./signal.ts";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG_FILE = join(PROJECT_ROOT, "scripts/steps.json");
// The overrides exist so a test writes to its own temp files instead of the run's.
const LOG_FILE = process.env.RUN_STEP_LOG ?? join(PROJECT_ROOT, "plans/diagrams/runs/run-log.md");
const CONFIG_FILE = process.env.RUN_STEP_CONFIG ?? DEFAULT_CONFIG_FILE;

type StepConfigEntry = { box: string; script: string; next: string[] };
type StepConfig = Record<string, StepConfigEntry[]>;
type Step = StepConfigEntry & { diagram: string };
type StepRun = {
    ok: boolean;
    box: string;
    command: string;
    exitCode: number | null;
    stdout: string;
    result: Record<string, unknown> | null;
};
type WalkResult = {
    ok: boolean;
    ran: string[];
    stoppedAt: string;
    why: string;
    output: unknown;
    isTerminal: boolean;
    report: string;
    nextStep: string;
};

// Every diagram's boxes in one map, keyed "diagram.mmd::BOX", so a seam is a plain lookup.
function buildStepsByKey(configFile: string): Map<string, Step> {
    const config = JSON.parse(readFileSync(configFile, "utf8")) as StepConfig;
    const stepsByKey = new Map<string, Step>();
    for (const [diagram, entries] of Object.entries(config)) {
        for (const entry of entries) {
            stepsByKey.set(`${diagram}::${entry.box}`, { ...entry, diagram });
        }
    }
    return stepsByKey;
}

const STEPS_BY_KEY = buildStepsByKey(CONFIG_FILE);

// A bare box id names its own diagram; one with :: names another.
function getStepKey(boxReference: string, fromDiagram: string): string {
    if (boxReference.includes("::")) {
        return boxReference;
    }
    return `${fromDiagram}::${boxReference}`;
}

function getStepKeysNamingBox(boxId: string): string[] {
    const matchingKeys: string[] = [];
    for (const stepKey of STEPS_BY_KEY.keys()) {
        const boxPart = stepKey.slice(stepKey.indexOf("::") + 2);
        if (boxPart === boxId) {
            matchingKeys.push(stepKey);
        }
    }
    return matchingKeys;
}

function appendStepToRunLog(boxId: string, invocation: string, command: string, commandOutput: string, output: unknown): void {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    const sourceLabel = CONFIG_FILE === DEFAULT_CONFIG_FILE ? "scripts/steps.json" : CONFIG_FILE;
    const logBlock = `${"=".repeat(7)} ${boxId} ${"=".repeat(6)}\n`
        + `Source ${sourceLabel}: ${boxId}\n`
        + `input: ${JSON.stringify({ invocation })}\n`
        + `====== command ======\n`
        + `${command}\n`
        + `====== end command ======\n`
        + `====== command output ======\n`
        + `${commandOutput}\n`
        + `====== end command output ======\n`
        + `output: ${JSON.stringify(output)}\n`
        + `${"=".repeat(36)}\n`;
    // One write, one string: many processes append to this file concurrently.
    appendFileSync(LOG_FILE, logBlock);
}

// Single quotes for the log line only: the spawn itself passes an argument list, never a shell string.
function getShellQuotedArgument(argument: string): string {
    return `'${argument.replaceAll("'", `'\\''`)}'`;
}

// A step's result is the last line it printed, so trailing chatter above it is allowed.
function parseStepResult(commandOutput: string): Record<string, unknown> | null {
    const lastLine = commandOutput.split("\n").at(-1) ?? "";
    try {
        return JSON.parse(lastLine);
    } catch {
        return null;
    }
}

function runStepScript(step: Step, input: string, invocation: string): StepRun {
    const nodeArguments = ["--no-inspect", step.script];
    if (input) {
        nodeArguments.push(input);
    }
    // Logged whole so the line in run-log.md is one you can paste into a terminal.
    const quotedInput = input ? ` ${getShellQuotedArgument(input)}` : "";
    const command = `node --no-inspect ${step.script}${quotedInput}`;
    const spawnResult = spawnSync("node", nodeArguments, { cwd: PROJECT_ROOT, encoding: "utf8" });
    const commandOutput = `${spawnResult.stdout ?? ""}${spawnResult.stderr ?? ""}`.trimEnd();
    const stepRun = {
        ok: spawnResult.status === 0,
        box: step.box,
        command,
        exitCode: spawnResult.status,
        stdout: commandOutput,
        result: parseStepResult(commandOutput),
    };
    appendStepToRunLog(step.box, invocation, command, commandOutput, stepRun);
    return stepRun;
}

// Where a fresh run picks up, by the same rule the walk itself follows. Empty when nothing follows.
function getNextStepAfter(stoppedAt: string, output: unknown): string {
    const step = STEPS_BY_KEY.get(stoppedAt)!;
    const namedNext = (output as { next?: unknown } | null)?.next;
    const onlySuccessor = step.next.length === 1 ? step.next[0] : undefined;
    const chosenNextBox = namedNext ?? onlySuccessor;
    if (chosenNextBox === undefined) {
        return "";
    }
    return getStepKey(String(chosenNextBox), step.diagram);
}

// A box with no arrow out of it ends a path. A block sets report for the user.
function buildWalkResult(ok: boolean, boxesRun: string[], stoppedAt: string, why: string, output: unknown): WalkResult {
    const isTerminal = STEPS_BY_KEY.get(stoppedAt)!.next.length === 0;
    const reportedOutput = output as { report?: unknown } | null;
    const report = typeof reportedOutput?.report === "string" ? reportedOutput.report : "";
    const nextStep = getNextStepAfter(stoppedAt, output);
    return { ok, ran: boxesRun, stoppedAt, why, output, isTerminal, report, nextStep };
}

// Runs a step, then keeps going while the graph names exactly one next box and the step says continue.
function walkFromStep(startStepKey: string, startInput: string, invocation: string): WalkResult {
    const boxesRun: string[] = [];
    let stepKey = startStepKey;
    let input = startInput;
    while (true) {
        const step = STEPS_BY_KEY.get(stepKey)!;
        const stepRun = runStepScript(step, input, invocation);
        boxesRun.push(stepKey);

        if (!stepRun.ok) {
            return buildWalkResult(false, boxesRun, stepKey, `exited ${stepRun.exitCode}`, stepRun.stdout);
        }
        if (!stepRun.result) {
            return buildWalkResult(false, boxesRun, stepKey, "printed no result object", stepRun.stdout);
        }

        const signal = stepRun.result.signal as Signal;
        if (!KNOWN_SIGNALS.includes(signal)) {
            const knownList = KNOWN_SIGNALS.map(known => JSON.stringify(known)).join(", ");
            return buildWalkResult(false, boxesRun, stepKey, `signal must be one of ${knownList}, not ${JSON.stringify(stepRun.result.signal)}`, stepRun.result);
        }
        if (signal === SIGNAL.STOP) {
            return buildWalkResult(true, boxesRun, stepKey, "signal stop", stepRun.result);
        }
        // The block printed a prompt instead of data, so an agent takes over here.
        if (signal === SIGNAL.PROMPT) {
            return buildWalkResult(true, boxesRun, stepKey, "signal prompt", stepRun.result);
        }
        if (step.next.length === 0) {
            return buildWalkResult(false, boxesRun, stepKey, `${stepKey} has an empty next; say where it goes next in steps.json`, stepRun.result);
        }

        // A box with one successor may leave next out of its output; a decision box must name its choice.
        const onlySuccessor = step.next.length === 1 ? step.next[0] : undefined;
        const chosenNextBox = stepRun.result.next ?? onlySuccessor;
        if (chosenNextBox === undefined) {
            return buildWalkResult(false, boxesRun, stepKey, `${stepKey} points at ${step.next.join(", ")}; its output must name one in next`, stepRun.result);
        }
        if (!step.next.includes(String(chosenNextBox))) {
            return buildWalkResult(false, boxesRun, stepKey, `next ${JSON.stringify(chosenNextBox)} is not one of ${step.next.join(", ")}`, stepRun.result);
        }

        const nextStepKey = getStepKey(String(chosenNextBox), step.diagram);
        if (!STEPS_BY_KEY.has(nextStepKey)) {
            return buildWalkResult(false, boxesRun, stepKey, `next box ${nextStepKey} is not in the config`, stepRun.result);
        }
        stepKey = nextStepKey;
        // A box sees only the box before it, so anything further back has to be carried forward by hand.
        input = JSON.stringify(stepRun.result);
    }
}

let payload: { hook_event_name?: unknown; prompt?: unknown };
try {
    payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
    process.exit(0);
}

// Plugin skills reach the hook namespaced, as /taskTools:run-step.
const promptText = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
if (!promptText.startsWith("/run-step")) {
    process.exit(0);
}

function injectResult(result: unknown): void {
    const injected = JSON.stringify({
        // Echoed from the payload: a name that disagrees with the firing event gets the output dropped.
        hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: JSON.stringify(result) },
    });
    process.stdout.write(`${injected}\n`);
}

const invocation = promptText.trim();
// The first word after the command names the box; everything after it is the first box's input.
const argumentText = invocation.slice("/run-step".length).trim();
const argumentMatch = argumentText.match(/^("[^"]*"|'[^']*'|\S+)\s*([\s\S]*)$/) ?? [];
const startBoxId = (argumentMatch[1] ?? "").replace(/^(["'])(.*)\1$/s, "$2");
const startInput = (argumentMatch[2] ?? "").trim();
const startStepKeys = startBoxId.includes("::")
    ? [startBoxId].filter(stepKey => STEPS_BY_KEY.has(stepKey))
    : getStepKeysNamingBox(startBoxId);

if (startStepKeys.length === 0) {
    const knownKeys = [...STEPS_BY_KEY.keys()].join(", ");
    injectResult({ ok: false, blockId: startBoxId, why: `no block named ${startBoxId || "<missing>"}; known: ${knownKeys}` });
    process.exit(0);
}
if (startStepKeys.length > 1) {
    const why = `${startBoxId} is named by more than one diagram: ${startStepKeys.join(", ")}; start it as diagram.mmd::${startBoxId}`;
    injectResult({ ok: false, blockId: startBoxId, why });
    process.exit(0);
}

injectResult(walkFromStep(startStepKeys[0]!, startInput, invocation));
