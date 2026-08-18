// Renders the happy path: its trace, the skill body, and every agent prompt it uses.
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
import { L } from "../tracePipeline.ts";

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

// Every workflow line that can print a trace line, in source order.
function workflowEmitters(): { line: number; text: string }[] {
    const emitters: { line: number; text: string }[] = [];
    readFileSync(WORKFLOW_PATH, "utf8").split("\n").forEach((source, index) => {
        const banner = source.match(/banner\('(.+)'\)/);
        if (banner) emitters.push({ line: index + 1, text: `--------- ${banner[1]} ---------` });
        // The label map itself writes bare ids, so only real L.ID uses match here.
        for (const [, id] of source.matchAll(/L\.([A-Z0-9_]+)/g)) emitters.push({ line: index + 1, text: L(id!) });
    });
    return emitters;
}

// step() prints the label alone, with a ": SUFFIX", or behind runAgent's agent marker.
const emitted = (traceLine: string, label: string): boolean =>
    traceLine === label || traceLine.startsWith(`${label}: `) || traceLine === `<-- AGENT --> ${label}`;

// Names the source line behind each trace line. Loops re-enter, so the search wraps around.
function annotate(trace: string[]): string[] {
    const emitters = workflowEmitters();
    const driverLine = readFileSync(WORKFLOW_PATH, "utf8").split("\n").findIndex((s) => s.includes("Run start: Task Num")) + 1;
    let cursor = 0;
    return trace.map((raw, index) => {
        const text = raw.trimStart();
        const ahead = emitters.findIndex((e, i) => i >= cursor && emitted(text, e.text));
        const found = ahead === -1 ? emitters.findIndex((e) => emitted(text, e.text)) : ahead;
        cursor = found + 1;
        const line = index === 0 ? driverLine : (found === -1 ? 0 : emitters[found]!.line);
        return `[workflow.js:${String(line).padStart(3)}]  ${raw}`;
    });
}

async function runWorkflow(fake: Decisions): Promise<string[]> {
    const source = readFileSync(WORKFLOW_PATH, "utf8").replace("export const meta", "const meta");
    const fn = compileFunction(
        // lineOffset -1 cancels the wrapper line, so a stack frame names the real source line.
        `return (async () => { 'use strict'\n${source} })()`,
        ["args", "log", "agent", "phase"],
        { filename: WORKFLOW_PATH, lineOffset: -1, importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    ) as (a: unknown, l: () => void, g: unknown, p: unknown) => Promise<string[]>;
    return annotate(await fn({ fake, task: fake.taskNumber }, () => {}, async () => {
        throw new Error("emitPipelineOutput: the workflow must not launch an agent");
    }, () => {}));
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
// The agent prompts, exactly as each subagent receives them from the workflow.
// ---------------------------------------------------------------------------

// The four agent boxes a run reaches when every block succeeds, in visit order.
export const HAPPY_PATH_ROLES = ["plan", "review-plan", "implement", "review-tests"] as const;

// fix-conflicts reads its file list from git, so it renders only where a rebase actually stopped.
const CONFLICT_ROLE = "fix-conflicts";

// One file per role, byte-pure, so a real run's logged prompt diffs against it cleanly.
export function writeAgentPrompts(taskNumber: number, projectRoot: string, pathName: string): string[] {
    const worktree = join(resolveTaskWorktreeConventionDirectory(projectRoot), `task-${taskNumber}`);
    // A path that stages no worktree has no brief, so there is no prompt to write.
    if (!existsSync(worktree)) return [];
    const directory = join(OUTPUT_DIR, String(taskNumber));
    mkdirSync(directory, { recursive: true });
    // Staged here, not in stagePath: the workflow trace resets the task branch and would undo the rebase.
    const conflicted = pathName === "rebase-conflict";
    if (conflicted) stopARebaseOnConflict(taskNumber, worktree, projectRoot);
    const roles: string[] = conflicted ? [...HAPPY_PATH_ROLES, CONFLICT_ROLE] : [...HAPPY_PATH_ROLES];
    return roles.map((role) => {
        const file = join(directory, `${role}.md`);
        writeFileSync(file, emitAgentPrompt(taskNumber, role, {
            worktree,
            projectRoot,
            checkoutPath: worktree,
            sourceBranch: currentBranchName(projectRoot),
            // No role reads runId, so a literal keeps this off the run-identity path.
            runId: "inspect",
        }));
        return file;
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
`;
}

export async function writePipelineOutput(taskNumber: number, projectRoot: string, pathName: string): Promise<string[]> {
    const trace = await runWorkflow(defaultDecisions(taskNumber));
    const file = join(OUTPUT_DIR, `pipeline-output-task-${taskNumber}-${pathName}.md`);
    mkdirSync(OUTPUT_DIR, { recursive: true });
    writeFileSync(file, render(taskNumber, projectRoot, pathName, trace));
    return [file, ...writeAgentPrompts(taskNumber, projectRoot, pathName)];
}

// ---------------------------------------------------------------------------
// Staging: put the repository into the real on-disk state one preamble path needs,
// so both halves of the rendered file describe the same run. Torn down again on quit.
// ---------------------------------------------------------------------------

export const STAGEABLE_PATHS = [
    "worktree-does-not-exist", "safe-existing-worktree",
    "unsafe-unresumable-worktree", "unsafe-resumable-worktree",
    "rebase-conflict",
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
    if (pathName !== "safe-existing-worktree" && pathName !== "rebase-conflict") {
        execFileSync("git", ["-C", created.worktree, "checkout", "--detach", "--quiet"]);
    }

    markTaskInactive({ taskNumber, runId: stageRunId, projectRoot });
    // A run that ended releases its lease; leaving it would stop the next run establishing one.
    releaseTaskWorktreeLease({ worktreePath: created.worktree, runId: stageRunId });
}

// Both sides touch the same line of the same new file, which is the smallest thing a rebase stops on.
function stopARebaseOnConflict(taskNumber: number, worktree: string, projectRoot: string): void {
    const git = (...args: string[]) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
    const sourceBranch = currentBranchName(projectRoot);
    const conflictFile = "conflict-fixture.md";
    writeFileSync(join(worktree, conflictFile), "task side\n");
    git("add", conflictFile);
    git("commit", "--quiet", "--no-verify", "-m", "conflict fixture: task side");
    git("checkout", "--quiet", "-b", "conflict-fixture-target", sourceBranch);
    writeFileSync(join(worktree, conflictFile), "target side\n");
    git("add", conflictFile);
    git("commit", "--quiet", "--no-verify", "-m", "conflict fixture: target side");
    git("checkout", "--quiet", taskBranchName(taskNumber));
    try {
        git("rebase", "conflict-fixture-target");
    } catch {
        // A rebase that stops on markers exits nonzero; that stopped state is the whole point.
    }
}

// Everything a run of this script can leave behind, removed newest-artifact-first.
function teardown(taskNumber: number, projectRoot: string, tasksSnapshot: Buffer): void {
    const conventionDirectory = resolveTaskWorktreeConventionDirectory(projectRoot);
    const worktreePath = join(conventionDirectory, `task-${taskNumber}`);
    const branch = taskBranchName(taskNumber);

    // Restored first: a throwing worktree removal must not strand the task marked active.
    writeFileSync(resolveTaskFiles(projectRoot).tasksPath, tasksSnapshot);
    rmSync(`${worktreePath}.lease`, { force: true });
    // The rebase-conflict stage leaves this behind; it lives in the shared repo, not the worktree.
    const fixtureBranch = execFileSync("git", ["-C", projectRoot, "branch", "--list", "conflict-fixture-target"], { encoding: "utf8" }).trim();
    if (fixtureBranch !== "") execFileSync("git", ["-C", projectRoot, "branch", "-D", "conflict-fixture-target"], { stdio: "ignore" });
    rmSync(taskWorktreeCreateJournalPath(worktreePath), { force: true });
    if (existsSync(worktreePath)) removeWorktreeAndBranch(projectRoot, worktreePath, branch);
}

function waitForQuit(): Promise<void> {
    if (!process.stdin.isTTY) return Promise.resolve();
    process.stdout.write("\npress enter to clean up and quit... ");
    return new Promise((resolve) => process.stdin.once("data", () => resolve()));
}

if (process.argv[1]?.endsWith("emitPipelineOutput.ts")) {
    const commandArguments = process.argv.slice(2);
    const pathFlagIndex = commandArguments.indexOf("--path");
    // Defaults to the path that stages a worktree, because every agent prompt needs one.
    const pathName = pathFlagIndex === -1 ? "safe-existing-worktree" : commandArguments[pathFlagIndex + 1];
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
        const files = await writePipelineOutput(taskNumber, projectRoot, pathName);
        process.stdout.write(`${files.join("\n")}\n`);
        const worktreePath = join(resolveTaskWorktreeConventionDirectory(projectRoot), `task-${taskNumber}`);
        if (existsSync(worktreePath)) process.stdout.write(`worktree: ${worktreePath}\n`);
        await waitForQuit();
    } finally {
        teardown(taskNumber, projectRoot, tasksSnapshot);
    }
    process.exit(0);
}
