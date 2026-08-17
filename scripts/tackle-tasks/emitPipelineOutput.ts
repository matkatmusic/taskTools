// Renders the skill body and the plan agent prompt for one preamble path.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileFunction, constants as vmConstants } from "node:vm";
import { skillBody } from "./SkillBodyEmitter.ts";
import { emitAgentPrompt } from "./AgentPromptEmitter.ts";
import { generateTaskDocs } from "./generateTaskDocs.ts";
import { currentBranchName } from "../repositoryBranches.ts";
import { isTaskActive } from "./isTaskActive.ts";
import { createTaskWorktree, taskBranchName, taskWorktreeCreateJournalPath } from "./createTaskWorktree.ts";
import { recordImplementationNotes } from "./recordImplementationNotes.ts";
import { markTaskInactive } from "./markTaskInactive.ts";
import { removeWorktreeAndBranch } from "../mergeTaskWorktrees.ts";
import { releaseTaskWorktreeLease, resolveTaskWorktreeConventionDirectory } from "../prepareTasks.ts";
import { resolveTaskFiles } from "../taskFiles.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EMITTER_PATH = fileURLToPath(new URL("./SkillBodyEmitter.ts", import.meta.url));
const EMITTER_NAME = "SkillBodyEmitter.ts";
const WORKFLOW_PATH = join(REPO_ROOT, "skills/tackle-tasks/tackle-tasks.workflow.js");
const OUTPUT_DIR = join(REPO_ROOT, "plans/diagram/output renders");

// ---------------------------------------------------------------------------
// The decisions the workflow walks. The preamble no longer runs here, so these start green.
// ---------------------------------------------------------------------------

type Decisions = Record<string, unknown>;

// A happy path. Edit one field to render any other route through the diagrams.
function defaultDecisions(taskNumber: number): Decisions {
    return {
        taskNumber,
        plannerOutcome: ["PLAN"],
        planVerdict: ["ACCEPT"],
        taskTestsPass: [true],
        testsFlagged: [false],
        lockAcquired: [true],
        rebaseConflicts: [false],
        rebaseFinished: [true],
        suitePasses: [true],
        fenceHeld: true,
        publicationState: ["ALL LANDED"],
    };
}

async function runWorkflow(fake: Decisions): Promise<string[]> {
    const source = readFileSync(WORKFLOW_PATH, "utf8").replace("export const meta", "const meta");
    const fn = compileFunction(
        `return (async () => { 'use strict'\n${source} })()`,
        ["args", "log", "agent", "phase"],
        { filename: WORKFLOW_PATH, importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    ) as (a: unknown, l: () => void, g: unknown, p: unknown) => Promise<string[]>;
    return fn({ fake, task: fake.taskNumber }, () => {}, async () => {
        throw new Error("emitPipelineOutput: the workflow must not launch an agent");
    }, () => {});
}

// ---------------------------------------------------------------------------
// skillBody() is one template literal, so output line i is source line start+i.
// ---------------------------------------------------------------------------

function templateFirstLine(): number {
    const lines = readFileSync(EMITTER_PATH, "utf8").split("\n");
    // Anchored on the body's own opening words, so an earlier short-circuit `return` cannot win.
    const index = lines.findIndex((line) => /^\s*return `WORKFLOW: /.test(line));
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

// ---------------------------------------------------------------------------
// The plan agent's prompt, exactly as its subagent receives it from the workflow.
// ---------------------------------------------------------------------------

export function planAgentPrompt(taskNumber: number, projectRoot: string): string {
    const worktree = join(resolveTaskWorktreeConventionDirectory(projectRoot), `task-${taskNumber}`);
    // A path that stages no worktree has no brief, so there is no prompt to show.
    if (!existsSync(worktree)) return "(this path stages no worktree, so no plan prompt exists yet)";
    return emitAgentPrompt(taskNumber, "plan", {
        worktree,
        projectRoot,
        sourceBranch: currentBranchName(projectRoot),
        // No role reads runId, so a literal keeps this off the run-identity path.
        runId: "inspect",
    });
}

function render(taskNumber: number, projectRoot: string, pathName: string, trace: string[]): string {
    return `<!-- ${pathName}   |   input: [${taskNumber}]

     Pipeline block printed by skills/tackle-tasks/tackle-tasks.workflow.js for this codepath.

${trace.map((line) => `       ${line}`).join("\n")}

     Below is what SkillBodyEmitter prints today, verbatim. Annotations are HTML comments, so
     stripping them leaves the body byte-faithful. Craft this into what SHOULD print for this path.
-->

${annotatedBody(taskNumber, projectRoot)}

<!--
  PLAN AGENT PROMPT

  AgentPromptEmitter.ts role "plan", verbatim. Only its subagent sees this in a real run.
-->

\`\`\`
${planAgentPrompt(taskNumber, projectRoot)}
\`\`\`
`;
}

export async function writePipelineOutput(taskNumber: number, projectRoot: string, pathName: string): Promise<string> {
    const trace = await runWorkflow(defaultDecisions(taskNumber));
    const file = join(OUTPUT_DIR, `pipeline-output-task-${taskNumber}-${pathName}.md`);
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(file, render(taskNumber, projectRoot, pathName, trace));
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
    // The preamble's docs box, staged too: without the brief the plan prompt cannot be built.
    generateTaskDocs(taskNumber, created.worktree, projectRoot);

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
        const file = await writePipelineOutput(taskNumber, projectRoot, pathName);
        process.stdout.write(`${file}\n`);
        const worktreePath = join(resolveTaskWorktreeConventionDirectory(projectRoot), `task-${taskNumber}`);
        if (existsSync(worktreePath)) process.stdout.write(`worktree: ${worktreePath}\n`);
        await waitForQuit();
    } finally {
        teardown(taskNumber, projectRoot, tasksSnapshot);
    }
    process.exit(0);
}
