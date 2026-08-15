// Writes plans/diagram/pipeline-output-<N>.md: the exact body SkillBodyEmitter prints for one
// task number, every line annotated with the SkillBodyEmitter.ts line it came from.
//
// N is found the way the user asked: run the real workflow for this task's codepath, take the
// pipeline block it prints, and match that block against the named fixtures in
// scripts/tracePipelinePaths.json. The matching fixture's 1-based position is N.
//
// Usage: node scripts/tackle-tasks/emitPipelineOutput.ts <taskNumber> [projectRoot]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, constants as vmConstants } from "node:vm";
import { skillBody } from "./SkillBodyEmitter.ts";
import { traceTaskPipeline, readNamedPaths } from "../tracePipeline.ts";
import { isTaskNumberValid } from "./isTaskNumberValid.ts";
import { isTaskBlocked } from "./isTaskBlocked.ts";
import { doesTaskWorktreeExist } from "./doesTaskWorktreeExist.ts";
import { checkTaskWorktreeSafe } from "./checkTaskWorktreeSafe.ts";
import { isTaskRunResumable } from "./isTaskRunResumable.ts";
import { getCurrentTaskRun } from "./taskRunState.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EMITTER_PATH = fileURLToPath(new URL("./SkillBodyEmitter.ts", import.meta.url));
const EMITTER_NAME = "SkillBodyEmitter.ts";
const WORKFLOW_PATH = join(REPO_ROOT, "skills/tackle-tasks/tackle-tasks.workflow.js");
const OUTPUT_DIR = join(REPO_ROOT, "plans/diagram/output renders");

// A read-only probe identity: nothing here claims a run, so no writer ever sees this id.
const PROBE_RUN_ID = "pipeline-output-probe";

// ---------------------------------------------------------------------------
// Preamble decisions, derived read-only. Nothing below mutates tasks.json or the worktree:
// a generator that marks your task active as a side effect is a trap.
// ---------------------------------------------------------------------------

type Decisions = Record<string, unknown>;

function derivePreambleDecisions(taskNumber: number, projectRoot: string): Decisions {
    const decisions: Decisions = {
        taskNumber,
        taskNumberValid: isTaskNumberValid(taskNumber, projectRoot).valid,
        taskActive: false,
        taskBlocked: false,
        worktreeExists: false,
        worktreeSafe: false,
        previousWorkResumable: false,
    };
    if (!decisions.taskNumberValid) return decisions;

    const currentRun = getCurrentTaskRun(taskNumber, projectRoot);
    decisions.taskActive = currentRun !== null && currentRun.exitType === null;
    if (decisions.taskActive) return decisions;

    decisions.taskBlocked = isTaskBlocked(taskNumber, projectRoot).blocked;
    if (decisions.taskBlocked) return decisions;

    const worktree = doesTaskWorktreeExist(taskNumber, projectRoot);
    decisions.worktreeExists = worktree.exists;
    if (!worktree.exists || worktree.worktree === null) return decisions;

    decisions.worktreeSafe = checkTaskWorktreeSafe(taskNumber, worktree.worktree).safe;
    if (decisions.worktreeSafe) return decisions;

    decisions.previousWorkResumable =
        isTaskRunResumable(taskNumber, worktree.worktree, PROBE_RUN_ID, projectRoot).resumable;
    return decisions;
}

// The downstream keys — codex verdicts, test outcomes, lock races — cannot be predicted from a
// task number, so they come from an existing fixture rather than being invented here.
function withDownstreamDefaults(preamble: Decisions): Decisions {
    const base = readNamedPaths()["safe-existing-worktree"] as unknown as Decisions;
    return { ...base, ...preamble };
}

// ---------------------------------------------------------------------------
// Run the real workflow for this codepath, then match its block against the fixtures.
// ---------------------------------------------------------------------------

async function runWorkflow(fake: Decisions): Promise<string[]> {
    const source = readFileSync(WORKFLOW_PATH, "utf8").replace("export const meta", "const meta");
    const fn = compileFunction(
        `return (async () => { 'use strict'\n${source} })()`,
        ["args", "log", "agent", "phase"],
        { filename: WORKFLOW_PATH, importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    ) as (a: unknown, l: () => void, g: unknown, p: unknown) => Promise<string[]>;
    return fn({ fake }, () => {}, async () => {
        throw new Error("emitPipelineOutput: the workflow must not launch an agent");
    }, () => {});
}

// The fixtures all carry taskNumber 42, which the trace's first line prints, so the real task
// number is substituted into each fixture before comparing rather than stripped from the trace.
export function matchPathNumber(trace: string[], taskNumber: number): { number: number; name: string } {
    const wanted = JSON.stringify(trace);
    const entries = Object.entries(readNamedPaths());
    const index = entries.findIndex(
        ([, decisions]) => JSON.stringify(traceTaskPipeline({ ...decisions, taskNumber })) === wanted,
    );
    if (index === -1) throw new Error("emitPipelineOutput: the workflow block matches no known fixture");
    return { number: index + 1, name: entries[index][0] };
}

// ---------------------------------------------------------------------------
// Annotate. skillBody() is one template literal, so output line i is source line start+i —
// computed from the source, never hand-mapped.
// ---------------------------------------------------------------------------

function templateFirstLine(): number {
    const lines = readFileSync(EMITTER_PATH, "utf8").split("\n");
    // Anchored on the body's own opening words, so an earlier short-circuit `return` cannot win.
    const index = lines.findIndex((line) => /^\s*return `Run /.test(line));
    if (index === -1) throw new Error(`emitPipelineOutput: no template literal found in ${EMITTER_NAME}`);
    return index + 1;
}

export function annotatedBody(taskNumber: number): string {
    const start = templateFirstLine();
    return skillBody(`[${taskNumber}]`, REPO_ROOT)
        .split("\n")
        .map((line, offset) => (line === "" ? line : `<!-- ${EMITTER_NAME}:${start + offset} -->\n${line}`))
        .join("\n");
}

function render(taskNumber: number, path: { number: number; name: string }, trace: string[]): string {
    return `<!-- PATH ${path.number} — ${path.name}   |   input: [${taskNumber}]

     Pipeline block printed by skills/tackle-tasks/tackle-tasks.workflow.js for this codepath,
     matched against scripts/tracePipelinePaths.json to give the path number above:

${trace.map((line) => `       ${line}`).join("\n")}

     Below is what SkillBodyEmitter prints today, verbatim. Annotations are HTML comments, so
     stripping them leaves the body byte-faithful. Craft this into what SHOULD print for this path.
-->

${annotatedBody(taskNumber)}`;
}

export async function writePipelineOutput(taskNumber: number, projectRoot: string): Promise<string> {
    const decisions = withDownstreamDefaults(derivePreambleDecisions(taskNumber, projectRoot));
    const trace = await runWorkflow(decisions);
    const path = matchPathNumber(trace, taskNumber);
    const file = join(OUTPUT_DIR, `pipeline-output-${path.number}.md`);
    writeFileSync(file, render(taskNumber, path, trace));
    return file;
}

if (process.argv[1]?.endsWith("emitPipelineOutput.ts")) {
    const taskNumber = Number(process.argv[2]);
    if (!Number.isInteger(taskNumber)) {
        process.stderr.write("usage: node emitPipelineOutput.ts <taskNumber> [projectRoot]\n");
        process.exit(1);
    }
    const file = await writePipelineOutput(taskNumber, process.argv[3] ?? REPO_ROOT);
    process.stdout.write(`${file}\n`);
}
