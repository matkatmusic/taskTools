// Writes plans/diagram/pipeline-output-<N>.md: the emitted body, annotated with its source lines.
//
// N is the 1-based position of the scripts/tracePipelinePaths.json fixture whose block matches.
//
// Usage: node scripts/tackle-tasks/emitPipelineOutput.ts <taskNumber> [projectRoot] [--path <name>]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, constants as vmConstants } from "node:vm";
import { skillBody } from "./SkillBodyEmitter.ts";
import { traceTaskPipeline, readNamedPaths } from "../tracePipeline.ts";
import { isTaskNumberValid } from "./isTaskNumberValid.ts";
import { isTaskBlocked } from "./isTaskBlocked.ts";
import { isTaskActive } from "./isTaskActive.ts";
import { doesTaskWorktreeExist } from "./doesTaskWorktreeExist.ts";
import { checkTaskWorktreeSafe } from "./checkTaskWorktreeSafe.ts";
import { isNotesFileContained } from "./isTaskRunResumable.ts";
import { createTaskWorktree, taskBranchName, taskWorktreeCreateJournalPath } from "./createTaskWorktree.ts";
import { recordImplementationNotes } from "./recordImplementationNotes.ts";
import { markTaskInactive } from "./markTaskInactive.ts";
import { getCurrentTaskRun, readTaskRunState } from "./taskRunState.ts";
import { removeWorktreeAndBranch } from "../mergeTaskWorktrees.ts";
import { releaseTaskWorktreeLease, resolveTaskWorktreeConventionDirectory } from "../prepareTasks.ts";
import { resolveTaskFiles } from "../taskFiles.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EMITTER_PATH = fileURLToPath(new URL("./SkillBodyEmitter.ts", import.meta.url));
const EMITTER_NAME = "SkillBodyEmitter.ts";
const WORKFLOW_PATH = join(REPO_ROOT, "skills/tackle-tasks/tackle-tasks.workflow.js");
const OUTPUT_DIR = join(REPO_ROOT, "plans/diagram/output renders");

// ---------------------------------------------------------------------------
// Preamble decisions, derived read-only: nothing below mutates tasks.json or the worktree.
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

    // Read-only twin of isTaskRunResumable: the newest ended run left notes inside the worktree.
    const endedRuns = readTaskRunState(taskNumber, projectRoot).history.filter((run) => run.endedAt !== null);
    const notesFile = endedRuns[endedRuns.length - 1]?.implementationNotesFile ?? null;
    decisions.previousWorkResumable = notesFile !== null && isNotesFileContained(worktree.worktree, notesFile);
    return decisions;
}

// Downstream keys cannot be predicted from a task number, so a fixture supplies them.
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

// Every fixture carries taskNumber 42, so the real number is substituted before comparing.
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
// skillBody() is one template literal, so output line i is source line start+i.
// ---------------------------------------------------------------------------

function templateFirstLine(): number {
    const lines = readFileSync(EMITTER_PATH, "utf8").split("\n");
    // Anchored on the body's own opening words, so an earlier short-circuit `return` cannot win.
    const index = lines.findIndex((line) => /^\s*return `Say: 'stopped at /.test(line));
    if (index === -1) throw new Error(`emitPipelineOutput: no template literal found in ${EMITTER_NAME}`);
    return index + 1;
}

export function annotatedBody(taskNumber: number, projectRoot: string): string {
    const start = templateFirstLine();
    return skillBody(`[${taskNumber}]`, projectRoot)
        .split("\n")
        .map((line, offset) => (line === "" ? line : `<!-- ${EMITTER_NAME}:${start + offset} -->\n${line}`))
        .join("\n");
}

function render(taskNumber: number, projectRoot: string, path: { number: number; name: string }, trace: string[]): string {
    return `<!-- PATH ${path.number} — ${path.name}   |   input: [${taskNumber}]

     Pipeline block printed by skills/tackle-tasks/tackle-tasks.workflow.js for this codepath,
     matched against scripts/tracePipelinePaths.json to give the path number above:

${trace.map((line) => `       ${line}`).join("\n")}

     Below is what SkillBodyEmitter prints today, verbatim. Annotations are HTML comments, so
     stripping them leaves the body byte-faithful. Craft this into what SHOULD print for this path.
-->

${annotatedBody(taskNumber, projectRoot)}`;
}

export async function writePipelineOutput(taskNumber: number, projectRoot: string): Promise<string> {
    const decisions = withDownstreamDefaults(derivePreambleDecisions(taskNumber, projectRoot));
    const trace = await runWorkflow(decisions);
    const path = matchPathNumber(trace, taskNumber);
    const file = join(OUTPUT_DIR, `pipeline-output-${path.number}.md`);
    writeFileSync(file, render(taskNumber, projectRoot, path, trace));
    return file;
}

// ---------------------------------------------------------------------------
// Staging: put the repository into the real on-disk state one preamble path needs,
// so both halves of the rendered file describe the same run. Torn down again on quit.
// ---------------------------------------------------------------------------

export const STAGEABLE_PATHS = [
    "worktree-does-not-exist", "safe-existing-worktree",
    "unsafe-unresumable-worktree", "unsafe-resumable-worktree",
] as const;

function stagePath(pathName: string, taskNumber: number, projectRoot: string): void {
    if (pathName === "worktree-does-not-exist") return;

    const stageRunId = `stage-${taskNumber}`;
    isTaskActive(taskNumber, stageRunId, projectRoot);
    const created = createTaskWorktree(taskNumber, stageRunId, projectRoot);

    if (pathName === "unsafe-resumable-worktree") {
        const notesFile = join(created.worktree, "plans", `implementation-notes-${taskNumber}.md`);
        mkdirSync(dirname(notesFile), { recursive: true });
        writeFileSync(notesFile, "staged by emitPipelineOutput\n");
        recordImplementationNotes(taskNumber, created.worktree, notesFile, stageRunId, projectRoot);
    }
    // A detached HEAD is the smallest thing checkTaskWorktreeSafe calls unsafe.
    if (pathName !== "safe-existing-worktree") {
        execFileSync("git", ["-C", created.worktree, "checkout", "--detach", "--quiet"]);
    }

    markTaskInactive({ taskNumber, runId: stageRunId, projectRoot });
    // A run that ended releases its lease; leaving it would stop the next run establishing one.
    releaseTaskWorktreeLease({ worktreePath: created.worktree, runId: stageRunId });
}

// Everything a run of this script can leave behind, removed newest-artifact-first.
function teardown(taskNumber: number, projectRoot: string, tasksSnapshot: Buffer): void {
    const conventionDirectory = resolveTaskWorktreeConventionDirectory(projectRoot);
    const worktreePath = join(conventionDirectory, `task-${taskNumber}`);
    const branch = taskBranchName(taskNumber);

    if (existsSync(worktreePath)) removeWorktreeAndBranch(projectRoot, worktreePath, branch);
    rmSync(`${worktreePath}.lease`, { force: true });
    rmSync(taskWorktreeCreateJournalPath(worktreePath), { force: true });
    writeFileSync(resolveTaskFiles(projectRoot).tasksPath, tasksSnapshot);
}

function waitForQuit(): Promise<void> {
    if (!process.stdin.isTTY) return Promise.resolve();
    process.stdout.write("\npress enter to clean up and quit... ");
    return new Promise((resolve) => process.stdin.once("data", () => resolve()));
}

if (process.argv[1]?.endsWith("emitPipelineOutput.ts")) {
    const commandArguments = process.argv.slice(2);
    const pathFlagIndex = commandArguments.indexOf("--path");
    const pathName = pathFlagIndex === -1 ? "worktree-does-not-exist" : commandArguments[pathFlagIndex + 1];
    const positional = pathFlagIndex === -1 ? commandArguments : commandArguments.toSpliced(pathFlagIndex, 2);

    const taskNumber = Number(positional[0]);
    if (!Number.isInteger(taskNumber)) {
        process.stderr.write(`usage: node emitPipelineOutput.ts <taskNumber> [projectRoot] [--path <${STAGEABLE_PATHS.join("|")}>]\n`);
        process.exit(1);
    }
    if (!(STAGEABLE_PATHS as readonly string[]).includes(pathName)) {
        process.stderr.write(`emitPipelineOutput: unknown --path "${pathName}"; pick one of ${STAGEABLE_PATHS.join(", ")}\n`);
        process.exit(1);
    }

    const projectRoot = positional[1] ?? REPO_ROOT;
    const tasksSnapshot = readFileSync(resolveTaskFiles(projectRoot).tasksPath);
    try {
        stagePath(pathName, taskNumber, projectRoot);
        const file = await writePipelineOutput(taskNumber, projectRoot);
        process.stdout.write(`${file}\n`);
        const worktreePath = join(resolveTaskWorktreeConventionDirectory(projectRoot), `task-${taskNumber}`);
        if (existsSync(worktreePath)) process.stdout.write(`worktree: ${worktreePath}\n`);
        await waitForQuit();
    } finally {
        teardown(taskNumber, projectRoot, tasksSnapshot);
    }
    process.exit(0);
}
