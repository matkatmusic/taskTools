// Runs one diagram block for /run-step, typed as a prompt so it fires inside a workflow subagent.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_SIGNALS, SIGNAL, type Signal } from "./signal.ts";
import { getPayloadFromOutput } from "./templateSchema.ts";

// Registered first so a throw while this file loads still reports, instead of dying silently.
process.on("uncaughtException", (error: Error) => {
    const reason = `run-step hook failed: ${error.stack ?? error.message}`;
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    process.exit(0);
});

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG_FILE = join(PROJECT_ROOT, "scripts/steps.json");
// The overrides exist so a test writes to its own temp files instead of the run's.
const LOG_FILE = process.env.RUN_STEP_LOG ?? join(PROJECT_ROOT, "plans/diagrams/runs/run-log.md");
const CONFIG_FILE = process.env.RUN_STEP_CONFIG ?? DEFAULT_CONFIG_FILE;
// ponytail: one flat cap per block. Claude Code kills the whole hook at 60s, so a walk of many blocks needs headroom.
const STEP_TIMEOUT_MS = 10_000;

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
type Outcome = {
    box: string;
    signal: string;
    next: string | null;
    payload: Record<string, unknown>;
    schema: Record<string, unknown> | null;
};
type WalkResult = {
    ok: boolean;
    ran: string[];
    errors: string[];
    outcome: Outcome | null;
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
    const spawnResult = spawnSync("node", nodeArguments, { cwd: PROJECT_ROOT, encoding: "utf8", timeout: STEP_TIMEOUT_MS });
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

// Where a fresh run picks up, by the same rule the walk itself follows. Null when nothing follows.
function getNextStepAfter(stoppedAt: string, output: Record<string, unknown>): string | null {
    const step = STEPS_BY_KEY.get(stoppedAt)!;
    const onlySuccessor = step.next.length === 1 ? step.next[0] : undefined;
    const chosenNextBox = output.next ?? onlySuccessor;
    if (chosenNextBox === undefined) {
        return null;
    }
    return getStepKey(String(chosenNextBox), step.diagram);
}

// A walk that could not finish has no outcome to report, so the reasons stand on their own.
function buildFailure(boxesRun: string[], errors: string[]): WalkResult {
    return { ok: false, ran: boxesRun, errors, outcome: null };
}

// A stop ends the run whatever the graph says, so only a prompt hands a next box back.
function buildSuccess(boxesRun: string[], stoppedAt: string, output: Record<string, unknown>): WalkResult {
    const next = output.signal === SIGNAL.STOP ? null : getNextStepAfter(stoppedAt, output);
    const outcome = {
        box: stoppedAt,
        signal: String(output.signal),
        next,
        payload: getPayloadFromOutput(output),
        // ponytail: the workflow builds its own schema today. Fill this when the hook owns that job.
        schema: null,
    };
    return { ok: true, ran: boxesRun, errors: [], outcome };
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
            // ponytail: a null exit code means killed, and the timeout is the only thing that kills a block here.
            const why = stepRun.exitCode === null ? `did not exit within ${STEP_TIMEOUT_MS}ms` : `exited ${stepRun.exitCode}`;
            return buildFailure(boxesRun, [`${stepKey} ${why}`, stepRun.stdout]);
        }
        if (!stepRun.result) {
            return buildFailure(boxesRun, [`${stepKey} printed no result object`, stepRun.stdout]);
        }

        const signal = stepRun.result.signal as Signal;
        if (!KNOWN_SIGNALS.includes(signal)) {
            const knownList = KNOWN_SIGNALS.map(known => JSON.stringify(known)).join(", ");
            return buildFailure(boxesRun, [`${stepKey} signal must be one of ${knownList}, not ${JSON.stringify(stepRun.result.signal)}`]);
        }
        if (signal === SIGNAL.STOP) {
            return buildSuccess(boxesRun, stepKey, stepRun.result);
        }
        // The block printed a prompt instead of data, so an agent takes over here.
        if (signal === SIGNAL.PROMPT) {
            return buildSuccess(boxesRun, stepKey, stepRun.result);
        }
        if (step.next.length === 0) {
            return buildFailure(boxesRun, [`${stepKey} has an empty next; say where it goes next in steps.json`]);
        }

        // A box with one successor may leave next out of its output; a decision box must name its choice.
        const onlySuccessor = step.next.length === 1 ? step.next[0] : undefined;
        const chosenNextBox = stepRun.result.next ?? onlySuccessor;
        if (chosenNextBox === undefined) {
            return buildFailure(boxesRun, [`${stepKey} points at ${step.next.join(", ")}; its output must name one in next`]);
        }
        if (!step.next.includes(String(chosenNextBox))) {
            return buildFailure(boxesRun, [`${stepKey} next ${JSON.stringify(chosenNextBox)} is not one of ${step.next.join(", ")}`]);
        }

        const nextStepKey = getStepKey(String(chosenNextBox), step.diagram);
        if (!STEPS_BY_KEY.has(nextStepKey)) {
            return buildFailure(boxesRun, [`next box ${nextStepKey} is not in the config`]);
        }
        stepKey = nextStepKey;
        // A box sees only the box before it, so anything further back has to be carried forward by hand.
        input = JSON.stringify(stepRun.result);
    }
}

const payload: { hook_event_name?: unknown; prompt?: unknown; tool_input?: Record<string, unknown> } = JSON.parse(readFileSync(0, "utf8"));

// Plugin skills reach the hook namespaced, as /taskTools:run-step and taskTools:run-step.
const promptText = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
const toolInput = payload.tool_input ?? {};
const skillName = String(toolInput.skill ?? "").replace(/^[\w-]+:/, "");
// A person types the whole line. An agent calls the skill, so the name and the args arrive apart.
const isTypedCommand = promptText.startsWith("/run-step");
const isSkillCall = skillName === "run-step";
if (!isTypedCommand && !isSkillCall) {
    process.exit(0);
}

function injectResult(result: unknown): void {
    const injected = JSON.stringify({
        // Echoed from the payload: a name that disagrees with the firing event gets the output dropped.
        hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: JSON.stringify(result) },
    });
    process.stdout.write(`${injected}\n`);
}

// The first word after the command names the box; everything after it is the first box's input.
const argumentText = isTypedCommand
    ? promptText.slice("/run-step".length).trim()
    : String(toolInput.args ?? "").trim();
// Rebuilt, not echoed, so the line the log prints is paste-runnable from either payload.
const invocation = `/run-step ${argumentText}`.trim();
const argumentMatch = argumentText.match(/^("[^"]*"|'[^']*'|\S+)\s*([\s\S]*)$/) ?? [];
const startBoxId = (argumentMatch[1] ?? "").replace(/^(["'])(.*)\1$/s, "$2");
const startInput = (argumentMatch[2] ?? "").trim();
const startStepKeys = startBoxId.includes("::")
    ? [startBoxId].filter(stepKey => STEPS_BY_KEY.has(stepKey))
    : getStepKeysNamingBox(startBoxId);

if (startStepKeys.length === 0) {
    const knownKeys = [...STEPS_BY_KEY.keys()].join(", ");
    injectResult(buildFailure([], [`no block named ${startBoxId || "<missing>"}; known: ${knownKeys}`]));
    process.exit(0);
}
if (startStepKeys.length > 1) {
    const why = `${startBoxId} is named by more than one diagram: ${startStepKeys.join(", ")}; start it as diagram.mmd::${startBoxId}`;
    injectResult(buildFailure([], [why]));
    process.exit(0);
}

injectResult(walkFromStep(startStepKeys[0]!, startInput, invocation));
