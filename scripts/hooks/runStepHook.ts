// Runs one diagram block for /run-step, typed as a prompt so it fires inside a workflow subagent.
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildPromptOutputTemplate, KNOWN_SCRIPT_SIGNALS, SCRIPT_SIGNAL, type ScriptSignal } from "../shared/contracts.ts";
import { getTemplateShapeMismatches } from "../shared/templateShape.ts";
import type { AgentOptions, BlockTemplate, StepConfig, StepConfigEntry } from "../tackle-tasks/generateSteps.ts";
import { readCheckpoint, writeCheckpoint } from "../tackle-tasks/shared/checkpoint.ts";
import { writeJsonAtomically } from "../shared/taskStateLock.ts";
import { readJsonFile } from "../tackle-tasks/shared/readJsonFile.ts";
import { taskWorkflowDirectory } from "../shared/taskFiles.ts";
import { currentBranchName, submodulePaths } from "../shared/repositoryBranches.ts";
import { resetTask } from "../tackle-tasks/resetTask.ts";
import { buildLockOwner, readSourceRepoLock } from "../tackle-tasks/shared/sourceRepoLock.ts";
import { findResumeEntry, findStartAtBlockEntry, prepareResume } from "../tackle-tasks/shared/resumeRun.ts";
import { resetAttemptCounts, writeTailCursor } from "../tackle-tasks/shared/taskRunState.ts";
import { SOURCE_LOCK_REACHABLE, SOURCE_LOCK_UNREACHABLE } from "../shared/resultCodes.ts";

// Registered first so a throw while this file loads still reports, instead of dying silently.
process.on("uncaughtException", (error: Error) => {
    const reason = `run-step hook failed: ${error.stack ?? error.message}`;
    process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
    mkdirSync(dirname(logFile()), { recursive: true });
    // Never re-reads the log since it may be corrupt; this last-resort handler always starts a fresh one instead.
    writeJsonAtomically(logFile(), [{ block: "HOOK EXCEPTION", reason }]);
    process.exit(0);
});

const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const DEFAULT_CONFIG_FILE = join(PROJECT_ROOT, "scripts/tackle-tasks/diagram-steps.json");
let CONFIG_FILE: string;
const SUCCESS_DIAGRAM = "pipeline-mergeSucceededExit.mmd";

// The env var is a test-only escape hatch (hooks.json sets no env for a real invocation); a real run's config is derived from its own packet, never accepted as a live override, so nothing can redirect a run already in flight.
// startInput is either the first pass's raw packet ({taskNumber, tasksFile, ...}) or a later pass's {packetFile: ...}
// wrapper; PREAMBLE_STATUS_CHECK.ts drops tasksFile from every packet after the first, so a later pass is resolved
// from the packet's own projectRoot instead.
function resolveConfigFile(startInput: string): string {
    if (process.env.RUN_STEP_CONFIG) {
        return process.env.RUN_STEP_CONFIG;
    }
    const wrapper = getPacketFromInput(startInput);
    const packet = typeof wrapper.packetFile === "string" ? JSON.parse(readFileSync(wrapper.packetFile, "utf8")) as Record<string, unknown> : wrapper;
    if (packet.taskNumber === undefined) {
        return DEFAULT_CONFIG_FILE;
    }
    if (typeof packet.tasksFile === "string") {
        return join(taskWorkflowDirectory(packet.tasksFile, Number(packet.taskNumber)), "steps.json");
    }
    if (typeof packet.projectRoot === "string") {
        return join(taskWorkflowDirectory(join(packet.projectRoot, ".taskTools", "tasks.json"), Number(packet.taskNumber)), "steps.json");
    }
    return DEFAULT_CONFIG_FILE;
}

// Local time, filesystem-safe, one per process: 2026-08-27T10-08-19-4213.
function runStamp(): string {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}-${process.pid}`;
}
// One folder per run holds packets; a packetFile names its run. RUN_STEP_LOG lets tests move the log, packets follow.
let runDirectory = process.env.RUN_STEP_LOG ? dirname(process.env.RUN_STEP_LOG) : join(process.cwd(), ".taskTools/runs", runStamp());
let packetSequence = 0;
let currentTaskNumber: number | null = null;
const logFile = () => process.env.RUN_STEP_LOG ?? join(runDirectory, `${currentTaskNumber === null ? "" : `task-${currentTaskNumber}-`}run-log.json`);
const packetsDirectory = () => join(runDirectory, "packets");
// ponytail: one flat cap per block; the full suite budget is 10 minutes, and the hook ceiling is 20 minutes.
const STEP_TIMEOUT_MS = 1_860_000;
const START_STEP_KEY = "pipeline-preambleStatusCheck.mmd::PREAMBLE_STATUS_CHECK";
const FAILURES_EXIT_KEY = "pipeline-failuresExit.mmd::FAILURES_EXIT";
const LOCK_SOURCE_REPO_BOX = "LOCK_SOURCE_REPO";
// Both exit tails release the source lock, so a block inside them starts without it.
const EXIT_DIAGRAMS = ["pipeline-failuresExit.mmd", SUCCESS_DIAGRAM];

type Step = StepConfigEntry & { diagram: string };
type StepRun = {
    ok: boolean;
    box: string;
    startedAt: number;
    command: string;
    exitCode: number | null;
    stdout: string;
    result: Record<string, unknown> | null;
};
// payload is the packet file path the next block starts from; an agent writes its answer there.
type Outcome = {
    next: string | null;
    payload: string;
    agent?: AgentOptions;
};
type HookOutput = {
    ok: boolean;
    ran: string[];
    errors: string[];
    outcome: Outcome | null;
    report?: string;
};

let CONFIG: StepConfig;

// Every diagram's boxes in one map, keyed "diagram.mmd::BOX", so a seam is a plain lookup.
function buildStepsByKey(config: StepConfig): Map<string, Step> {
    const stepsByKey = new Map<string, Step>();
    for (const [diagram, entries] of Object.entries(config)) {
        for (const entry of entries) {
            stepsByKey.set(`${diagram}::${entry.box}`, { ...entry, diagram });
        }
    }
    return stepsByKey;
}

let STEPS_BY_KEY: Map<string, Step>;

// A bare box id names its own diagram; one with :: names another.
function getStepKey(boxReference: string, fromDiagram: string): string {
    if (boxReference.includes("::")) {
        return boxReference;
    }
    const sameDiagramKey = `${fromDiagram}::${boxReference}`;
    if (STEPS_BY_KEY.has(sameDiagramKey)) {
        return sameDiagramKey;
    }
    return getStepKeysNamingBox(boxReference)[0] ?? sameDiagramKey;
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

function took(ms: number): string {
    if (ms > 60_000)
        return `${Math.floor(ms / 60_000)}:${(ms % 60_000 / 1000).toFixed(2).padStart(5, "0")}`;
    if (ms > 1000)
        return `${(ms / 1000).toFixed(2)} s`;
    return `${ms} ms`;
}

function appendStepToRunLog(stepKey: string, tookMs: number): void {
    mkdirSync(dirname(logFile()), { recursive: true });
    // The log is one JSON array; each pass of a run rewrites it whole, and passes never overlap.
    const runLogEntries = existsSync(logFile()) ? readJsonFile(logFile()) as unknown[] : [];
    runLogEntries.push({ block: stepKey, duration: took(tookMs), durationMs: tookMs });
    writeJsonAtomically(logFile(), runLogEntries);
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

// Every repo's HEAD before this block runs; a block reset restores each to what's recorded here.
function buildRewindPoints(worktree: string): Record<string, string> {
    if (worktree === "" || spawnSync("git", ["-C", worktree, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).status !== 0) {
        return {};
    }
    const rewindPoints: Record<string, string> = {};
    // submodulePaths only needs a resolvable rev; "HEAD" stands in when detached (mid-rebase).
    const branch = currentBranchName(worktree) || "HEAD";
    for (const occurrenceId of ["", ...submodulePaths(worktree, branch)]) {
        const path = occurrenceId === "" ? worktree : join(worktree, occurrenceId);
        rewindPoints[occurrenceId] = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    }
    return rewindPoints;
}

function runStepScript(step: Step, input: string, invocation: string): StepRun {
    const nodeArguments = ["--no-inspect", step.script];
    if (input) {
        nodeArguments.push(input);
    }
    // Logged whole so the line in run-log.json is one you can paste into a terminal.
    const quotedInput = input ? ` ${getShellQuotedArgument(input)}` : "";
    const command = `node --no-inspect ${step.script}${quotedInput}`;
    const startedAt = Date.now();
    const packetBeforeRun = getPacketFromInput(input);
    const rewindPoints = buildRewindPoints(typeof packetBeforeRun.worktree === "string" ? packetBeforeRun.worktree : "");
    const spawnResult = spawnSync("node", nodeArguments, { cwd: PROJECT_ROOT, encoding: "utf8", timeout: STEP_TIMEOUT_MS, env: { ...process.env, RUN_STEP_LOG: logFile() } });
    const tookMs = Date.now() - startedAt;
    const commandOutput = `${spawnResult.stdout ?? ""}${spawnResult.stderr ?? ""}`.trimEnd();
    const stepRun = {
        ok: spawnResult.status === 0,
        box: step.box,
        startedAt,
        command,
        exitCode: spawnResult.status,
        stdout: commandOutput,
        // stderr is chatter (git prints "Reset branch" there), so the result line is read from stdout alone.
        result: parseStepResult((spawnResult.stdout ?? "").trimEnd()),
    };
    // The log dropped these four values; this per-block packet is where they live now.
    packetSequence += 1;
    mkdirSync(packetsDirectory(), { recursive: true });
    // NN is the count of files already in the folder, so a listing sorts in write order.
    const traceOrdinal = String(readdirSync(packetsDirectory()).length).padStart(2, "0");
    writeJsonAtomically(join(packetsDirectory(), `${traceOrdinal}-${step.box}-${process.pid}-${packetSequence}.json`), { input: { invocation }, command, commandOutput, output: stepRun, rewindPoints });
    appendStepToRunLog(`${step.diagram}::${step.box}`, tookMs);
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

// A block holds the source lock when the walk can reach it from LOCK_SOURCE_REPO without entering an exit diagram.
function isInsideSourceLock(stepKey: string): number {
    const lockStepKey = getStepKeysNamingBox(LOCK_SOURCE_REPO_BOX)[0];
    if (lockStepKey === undefined) return SOURCE_LOCK_UNREACHABLE;
    const reached = new Set<string>();
    const toVisit = [...STEPS_BY_KEY.get(lockStepKey)!.next.map((box) => getStepKey(box, STEPS_BY_KEY.get(lockStepKey)!.diagram))];
    while (toVisit.length > 0) {
        const visiting = toVisit.pop()!;
        const step = STEPS_BY_KEY.get(visiting);
        if (step === undefined || reached.has(visiting) || EXIT_DIAGRAMS.includes(step.diagram)) continue;
        reached.add(visiting);
        toVisit.push(...step.next.map((box) => getStepKey(box, step.diagram)));
    }
    return reached.has(stepKey) ? SOURCE_LOCK_REACHABLE : SOURCE_LOCK_UNREACHABLE;
}

// A failed walk has no outcome, unless its worktree lives outside an exit diagram, then it joins the tail.
function buildFailure(
    boxesRun: string[],
    errors: string[],
    context: { step: Step; packet: Record<string, unknown>; input: string; startedFromPacketFile: boolean } | null = null,
): HookOutput {
    mkdirSync(dirname(logFile()), { recursive: true });
    const runLogEntries = existsSync(logFile()) ? readJsonFile(logFile()) as unknown[] : [];
    runLogEntries.push({ block: "FAILURE", invocation, ran: boxesRun, errors });
    writeJsonAtomically(logFile(), runLogEntries);
    const report = `The workflow failed to complete successfully: ${errors.join("\n")}\nSee ${runDirectory} for specific inputs and outputs of each run-step block's execution.`;
    if (context === null) return { ok: false, ran: boxesRun, errors, outcome: null, report };
    if (EXIT_DIAGRAMS.includes(context.step.diagram)) return { ok: false, ran: boxesRun, errors, outcome: null, report };
    const worktree = typeof context.packet.worktree === "string" ? context.packet.worktree : "";
    const worktreeExists = worktree !== "" && existsSync(worktree);
    if (!worktreeExists) return { ok: false, ran: boxesRun, errors, outcome: null, report };
    if (!STEPS_BY_KEY.has(FAILURES_EXIT_KEY)) return { ok: false, ran: boxesRun, errors, outcome: null, report };

    const stepKey = `${context.step.diagram}::${context.step.box}`;
    const existing = readCheckpoint(worktree);
    const sourceLockHeld = readSourceRepoLock(String(context.packet.projectRoot ?? ""))?.owner
        === buildLockOwner(String(context.packet.runId ?? ""), Number(context.packet.taskNumber));
    const consumedAPrompt = context.startedFromPacketFile && boxesRun.length === 1;
    // The run log keeps the whole stack; the note keeps the thrown message line only, when there is one.
    const thrownMessageLine = errors.slice(1).join("\n").split("\n").find((line) => /^\w*Error: /.test(line));
    const exitNote = thrownMessageLine === undefined ? errors.join("\n") : `${errors[0]}\n${thrownMessageLine}`;
    if (consumedAPrompt && existing === null) throw new Error(`${stepKey} answered a prompt but ${worktree} holds no checkpoint`);
    writeCheckpoint(worktree, {
        taskNumber: Number(context.packet.taskNumber),
        passId: existing?.passId ?? randomUUID(),
        runId: String(context.packet.runId ?? ""),
        projectRoot: String(context.packet.projectRoot ?? ""),
        block: consumedAPrompt ? existing!.block : stepKey,
        input: consumedAPrompt ? existing!.input : context.input,
        state: "failed",
        sourceLockHeld,
        exitType: "block-failed",
        exitNote,
        resumedFrom: existing?.resumedFrom ?? null,
    });
    const tailInput = JSON.stringify({
        ...context.packet, box: context.step.box, scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        exitType: "block-failed", exitNote, branch: String(context.packet.branch ?? ""),
    });
    const tailResult = walkFromStep(FAILURES_EXIT_KEY, tailInput, invocation);
    return { ok: false, ran: [...boxesRun, ...tailResult.ran], errors, outcome: null, report };
}

function readTemplate(step: Step): BlockTemplate {
    return JSON.parse(readFileSync(resolve(PROJECT_ROOT, step.template), "utf8")) as BlockTemplate;
}

// A prompt block must print the canonical prompt shape; any other block must print its template's output.
function getOutputContractMismatches(step: Step, result: Record<string, unknown>): string[] {
    const expected = step.producesPrompt
        ? { ...buildPromptOutputTemplate(step.box), ...(readTemplate(step).output as Record<string, unknown> | undefined ?? {}) }
        : readTemplate(step).output;
    if (expected === undefined) {
        return [`${step.template} declares no output`];
    }
    return getTemplateShapeMismatches(expected, result);
}

// The walk's first input crosses a trust boundary, so it must match the start block's declared input.
function getStartInputMismatches(step: Step, startInput: string): string[] {
    const templateInput = readTemplate(step).input;
    if (typeof templateInput !== "object" || templateInput === null || Object.keys(templateInput).length === 0) {
        return [];
    }
    let parsedInput: unknown;
    try {
        parsedInput = JSON.parse(startInput);
    } catch {
        return [`input must be JSON matching ${JSON.stringify(templateInput)}, got ${JSON.stringify(startInput)}`];
    }
    return getTemplateShapeMismatches(templateInput, parsedInput);
}

// A pipeline block's input is a JSON object; a bare string input carries no packet fields.
function getPacketFromInput(input: string): Record<string, unknown> {
    if (!input.startsWith("{")) {
        return {};
    }
    return JSON.parse(input) as Record<string, unknown>;
}

// A stop ends the run whatever the graph says, so only a prompt hands a next box back.
function buildSuccess(boxesRun: string[], stoppedAt: string, stepRun: StepRun, input: string): HookOutput {
    const output = stepRun.result!;
    const next = output.scriptSignal === SCRIPT_SIGNAL.STOP ? null : getNextStepAfter(stoppedAt, output);
    // What the next block starts from: after a prompt, its input, prompt, and start time; otherwise this block's output.
    const packet = output.scriptSignal === SCRIPT_SIGNAL.PROMPT ? { ...getPacketFromInput(input), prompt: output.prompt, startedAt: stepRun.startedAt } : output;
    mkdirSync(packetsDirectory(), { recursive: true });
    const payloadOrdinal = String(readdirSync(packetsDirectory()).length).padStart(2, "0");
    const payload = join(packetsDirectory(), `${payloadOrdinal}-${String(output.box)}-${process.pid}.json`);
    writeJsonAtomically(payload, packet);
    // A run that completed has no next pass to feed; its log stays, its packets go.
    // if (next === null && stoppedAt.startsWith(`${SUCCESS_DIAGRAM}::`)) rmSync(packetsDirectory(), { recursive: true, force: true });
    return { ok: true, ran: boxesRun, errors: [], outcome: { next, payload, agent: STEPS_BY_KEY.get(String(next))?.agent } };
}

// The packet is the previous block's output, unchanged; only the next block and its agent options are new.
function buildWalkerStop(boxesRun: string[], nextStepKey: string, packet: Record<string, unknown>): HookOutput {
    const nextStep = STEPS_BY_KEY.get(nextStepKey)!;
    mkdirSync(packetsDirectory(), { recursive: true });
    const payloadOrdinal = String(readdirSync(packetsDirectory()).length).padStart(2, "0");
    const payload = join(packetsDirectory(), `${payloadOrdinal}-${nextStep.box}-${process.pid}.json`);
    writeJsonAtomically(payload, packet);
    return { ok: true, ran: boxesRun, errors: [], outcome: { next: nextStepKey, payload, agent: nextStep.agent } };
}

// Runs a step, then keeps going while the graph names exactly one next box and the step says continue.
function walkFromStep(startStepKey: string, startInput: string, invocation: string): HookOutput {
    // A packetFile in the input expands to that file; the agent's prompt answer is not block input.
    const startPacket = getPacketFromInput(startInput);
    if (startPacket.taskNumber !== undefined) currentTaskNumber = Number(startPacket.taskNumber);
    const startedFromPacketFile = typeof startPacket.packetFile === "string";
    // The hook's cwd is the agent's shell folder; the project root, not cwd, owns the run folder.
    if (!process.env.RUN_STEP_LOG && !startedFromPacketFile && typeof startPacket.projectRoot === "string") {
        runDirectory = join(startPacket.projectRoot, ".taskTools/runs", runStamp());
    }
    if (typeof startPacket.packetFile === "string") {
        if (!process.env.RUN_STEP_LOG) runDirectory = dirname(dirname(startPacket.packetFile));
        if (!existsSync(startPacket.packetFile)) {
            return buildFailure([], [`packet file ${startPacket.packetFile} does not exist`]);
        }
        const packetFileText = readFileSync(startPacket.packetFile, "utf8");
        if (packetFileText.trim() === "") {
            return buildFailure([], [`packet file ${startPacket.packetFile} is empty`]);
        }
        const { prompt: _prompt, startedAt, ...packet } = JSON.parse(packetFileText);
        if (packet.taskNumber !== undefined) currentTaskNumber = Number(packet.taskNumber);
        // The prompt block's own entry counted only its script; the agent's time runs from that start until this call.
        const promptBox = basename(startPacket.packetFile).replace(/^\d+-/, "").replace(/-\d+\.json$/, "");
        const promptBoxStepKey = getStepKeysNamingBox(promptBox)[0];
        if (promptBoxStepKey === undefined) {
            throw new Error(`no block named ${promptBox}`);
        }
        if (startedAt !== undefined) {
            const agentTookMs = Date.now() - Number(startedAt);
            mkdirSync(dirname(logFile()), { recursive: true });
            const runLogEntries = existsSync(logFile()) ? readJsonFile(logFile()) as unknown[] : [];
            runLogEntries.push({ block: `${promptBoxStepKey} agent`, duration: took(agentTookMs), durationMs: agentTookMs });
            writeJsonAtomically(logFile(), runLogEntries);
        }
        startInput = JSON.stringify(packet);
    }
    // A launch naming a later block starts there if its worktree, plan, brief and input exist; otherwise it's ignored.
    if (startStepKey !== START_STEP_KEY && typeof startPacket.tasksFile === "string") {
        const taskNumber = Number(startPacket.taskNumber);
        const entry = findStartAtBlockEntry(taskNumber, String(startPacket.tasksFile), STEPS_BY_KEY.get(startStepKey)!.box, dirname(runDirectory));
        if (entry === null) return walkFromStep(START_STEP_KEY, startInput, invocation);
        prepareResume({ taskNumber, runId: entry.runId, projectRoot: entry.projectRoot, sourceLockHeld: isInsideSourceLock(startStepKey) === SOURCE_LOCK_REACHABLE });
        resetAttemptCounts(taskNumber, entry.runId, entry.projectRoot);
        startInput = entry.input;
    }
    if (startStepKey === START_STEP_KEY) {
        const entry = findResumeEntry(Number(startPacket.taskNumber), String(startPacket.tasksFile));
        if (entry !== null) {
            return walkFromStep(entry.block, entry.input, invocation);
        }
    }
    const startInputMismatches = getStartInputMismatches(STEPS_BY_KEY.get(startStepKey)!, startInput);
    if (startInputMismatches.length > 0) {
        return buildFailure([], [`${startStepKey} input breaks its contract`, ...startInputMismatches]);
    }
    const boxesRun: string[] = [];
    let stepKey = startStepKey;
    let input = startInput;
    let inFailureChain = startStepKey.startsWith("pipeline-failuresExit.mmd::");
    while (true) {
        const step = STEPS_BY_KEY.get(stepKey)!;
        const packet = getPacketFromInput(input);
        // A prompt block runs under its own model; the walk stops and names it for the next agent.
        if (step.producesPrompt && boxesRun.length > 0) {
            return buildWalkerStop(boxesRun, stepKey, packet);
        }
        const worktree = typeof packet.worktree === "string" ? packet.worktree : "";
        const worktreeExists = worktree !== "" && existsSync(worktree);
        // A prompt block and its answer-consuming block checkpoint at the block that feeds the prompt, so resuming reproduces it.
        const answersAPrompt = startedFromPacketFile && boxesRun.length === 0;
        if (!inFailureChain && worktreeExists && !step.producesPrompt && !answersAPrompt) {
            const existing = readCheckpoint(worktree);
            writeCheckpoint(worktree, {
                taskNumber: Number(packet.taskNumber),
                passId: existing?.block === stepKey && existing?.input === input ? existing.passId : randomUUID(),
                runId: String(packet.runId ?? ""),
                projectRoot: String(packet.projectRoot ?? ""),
                block: stepKey,
                input,
                state: "running",
                sourceLockHeld: false,
                exitType: "",
                exitNote: "",
                resumedFrom: existing?.resumedFrom ?? null,
            });
        }
        // Inside an exit tail, the checkpoint freezes; this durable cursor lets a later box resume after a crash.
        if (inFailureChain) {
            // A box with no successor needs no cursor; one would undo REPORT_EXIT_TYPE_AND_NOTE's clear.
            if (step.next.length > 0) {
                writeTailCursor(Number(packet.taskNumber), String(packet.runId ?? ""), { block: stepKey, input }, String(packet.projectRoot ?? ""));
            }
        }
        const stepRun = runStepScript(step, input, invocation);
        boxesRun.push(stepKey);

        if (!stepRun.ok) {
            // ponytail: a null exit code means killed, and the timeout is the only thing that kills a block here.
            const why = stepRun.exitCode === null ? `did not exit within ${STEP_TIMEOUT_MS}ms` : `exited ${stepRun.exitCode}`;
            return buildFailure(boxesRun, [`${stepKey} ${why}`, stepRun.stdout], { step, packet, input, startedFromPacketFile });
        }
        if (!stepRun.result) {
            return buildFailure(boxesRun, [`${stepKey} printed no result object`, stepRun.stdout], { step, packet, input, startedFromPacketFile });
        }

        const scriptSignal = stepRun.result.scriptSignal as ScriptSignal;
        if (!KNOWN_SCRIPT_SIGNALS.includes(scriptSignal)) {
            const knownList = KNOWN_SCRIPT_SIGNALS.map(known => JSON.stringify(known)).join(", ");
            return buildFailure(boxesRun, [`${stepKey} scriptSignal must be one of ${knownList}, not ${JSON.stringify(stepRun.result.scriptSignal)}`], { step, packet, input, startedFromPacketFile });
        }
        // The diagram's returns_a_prompt mark and the printed scriptSignal must agree, both ways.
        if (step.producesPrompt && scriptSignal !== SCRIPT_SIGNAL.PROMPT) {
            return buildFailure(boxesRun, [`${stepKey} is marked returns_a_prompt but printed scriptSignal ${JSON.stringify(scriptSignal)}`], { step, packet, input, startedFromPacketFile });
        }
        if (!step.producesPrompt && scriptSignal === SCRIPT_SIGNAL.PROMPT) {
            return buildFailure(boxesRun, [`${stepKey} printed scriptSignal "prompt" but is not marked returns_a_prompt in its diagram`], { step, packet, input, startedFromPacketFile });
        }
        const contractMismatches = getOutputContractMismatches(step, stepRun.result);
        if (contractMismatches.length > 0) {
            return buildFailure(boxesRun, [`${stepKey} output breaks its contract`, ...contractMismatches], { step, packet, input, startedFromPacketFile });
        }
        if (scriptSignal === SCRIPT_SIGNAL.STOP) {
            return buildSuccess(boxesRun, stepKey, stepRun, input);
        }
        // The block printed a prompt instead of data, so an agent takes over here.
        if (scriptSignal === SCRIPT_SIGNAL.PROMPT) {
            return buildSuccess(boxesRun, stepKey, stepRun, input);
        }
        if (step.next.length === 0) {
            return buildFailure(boxesRun, [`${stepKey} has an empty next; say where it goes next in steps.json`], { step, packet, input, startedFromPacketFile });
        }

        // A box with one successor may leave next out of its output; a decision box must name its choice.
        const onlySuccessor = step.next.length === 1 ? step.next[0] : undefined;
        const chosenNextBox = stepRun.result.next ?? onlySuccessor;
        if (chosenNextBox === undefined) {
            return buildFailure(boxesRun, [`${stepKey} points at ${step.next.join(", ")}; its output must name one in next`], { step, packet, input, startedFromPacketFile });
        }
        if (!step.next.includes(String(chosenNextBox))) {
            return buildFailure(boxesRun, [`${stepKey} next ${JSON.stringify(chosenNextBox)} is not one of ${step.next.join(", ")}`], { step, packet, input, startedFromPacketFile });
        }
        const nextStepKey = getStepKey(String(chosenNextBox), step.diagram);
        if (!STEPS_BY_KEY.has(nextStepKey)) {
            return buildFailure(boxesRun, [`next box ${nextStepKey} is not in the config`], { step, packet, input, startedFromPacketFile });
        }
        if (nextStepKey === FAILURES_EXIT_KEY && !inFailureChain) {
            if (worktreeExists) {
                const existing = readCheckpoint(worktree);
                const sourceLockHeld = readSourceRepoLock(String(packet.projectRoot ?? ""))?.owner
                    === buildLockOwner(String(packet.runId ?? ""), Number(packet.taskNumber));
                // The block that consumed a prompt answer fails back to the block that fed the prompt.
                const consumedAPrompt = startedFromPacketFile && boxesRun.length === 1;
                if (consumedAPrompt && existing === null) throw new Error(`${stepKey} answered a prompt but ${worktree} holds no checkpoint`);
                writeCheckpoint(worktree, {
                    taskNumber: Number(packet.taskNumber),
                    passId: existing?.passId ?? randomUUID(),
                    runId: String(packet.runId ?? ""),
                    projectRoot: String(packet.projectRoot ?? ""),
                    block: consumedAPrompt ? existing!.block : stepKey,
                    input: consumedAPrompt ? existing!.input : input,
                    state: "failed",
                    sourceLockHeld,
                    exitType: String(stepRun.result.exitType ?? ""),
                    exitNote: String(stepRun.result.exitNote ?? ""),
                    resumedFrom: existing?.resumedFrom ?? null,
                });
            }
            inFailureChain = true;
        }
        // The block that consumed a prompt answer checkpoints once it succeeds; a later prompt block resumes from there.
        if (answersAPrompt && !step.producesPrompt && worktreeExists && !inFailureChain) {
            const existing = readCheckpoint(worktree);
            writeCheckpoint(worktree, {
                taskNumber: Number(packet.taskNumber),
                passId: existing?.block === stepKey && existing?.input === input ? existing.passId : randomUUID(),
                runId: String(packet.runId ?? ""),
                projectRoot: String(packet.projectRoot ?? ""),
                block: stepKey,
                input,
                state: "running",
                sourceLockHeld: false,
                exitType: "",
                exitNote: "",
                resumedFrom: existing?.resumedFrom ?? null,
            });
        }
        stepKey = nextStepKey;
        // A box sees only the prior box; next is consumed here, so a spreading box never inherits its choice.
        const { next: _next, ...resultWithoutNext } = stepRun.result;
        input = JSON.stringify(resultWithoutNext);
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
// The hook runs `/tackle-tasks reset N` itself, typed or as a Skill call; the agent runs nothing.
const resetLine = skillName === "tackle-tasks" ? `/tackle-tasks ${String(toolInput.args ?? "")}` : promptText;
const resetMatch = resetLine.match(/^\/tackle-tasks\s+reset\s+(\d+)(?:\s+(\S+))?\s*$/);
if (resetMatch !== null) {
    const said = await resetTask(Number(resetMatch[1]), resetMatch[2] ?? "");
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: said } })}\n`);
    process.exit(0);
}
if (!isTypedCommand && !isSkillCall) {
    process.exit(0);
}

// A next box after a stop means a prompt is waiting in the packet file for the agent.
function getInstructionsForAgent(result: HookOutput): string {
    if (result.report !== undefined) {
        return `Print out the following verbatim to the user: \`\`\`${result.report}\`\`\``;
    }
    if (result.outcome === null || result.outcome.next === null) {
        return "";
    }
    // The walk stopped before a prompt block, so the packet holds no prompt; the agent only relays output.
    if (STEPS_BY_KEY.get(result.outcome.next)!.producesPrompt) {
        return `The walk stopped before ${result.outcome.next}. Do not run it, do not read its packet, do not delegate it. Your only job now: return the JSON object above verbatim.`;
    }
    return [
        `The file at ${result.outcome.payload} holds a prompt under the key "prompt". Do these four steps in order.`,
        "1. Read that file.",
        "2. Follow the prompt.",
        `3. Write the object the prompt asks you to return by piping it on stdin to: node ${PROJECT_ROOT}/scripts/tackle-tasks/shared/writeAgentAnswer.ts "${result.outcome.payload}" — never edit the packet file by hand.`,
        "4. Only after step 3 is done, return the JSON object above verbatim.",
        "The next block reads that file and fails when message and additionalData are missing, so step 3 is not optional.",
    ].join(" ");
}

function injectResult(result: HookOutput): void {
    const additionalContext = `${JSON.stringify(result)}\n${getInstructionsForAgent(result)}`.trimEnd();
    const injected = JSON.stringify({
        // Echoed from the payload: a name that disagrees with the firing event gets the output dropped.
        hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext },
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
CONFIG_FILE = resolveConfigFile(startInput);
CONFIG = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StepConfig;
STEPS_BY_KEY = buildStepsByKey(CONFIG);
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
