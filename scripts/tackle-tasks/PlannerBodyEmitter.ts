// The planner phase of tackle-tasks, one function per box in plans/diagram/pipeline-preamble.mmd.  Every box name in a trailing comment is the box's label in that diagram, verbatim.  Every function below is a thin wrapper around an already-tested export; none of them open tasks.json themselves, and each re-derives what it needs from the task number.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { isTaskNumberValid } from "./isTaskNumberValid.ts";
import { isTaskBlocked } from "./isTaskBlocked.ts";
import { claimTask } from "./taskRunState.ts";
import { doesTaskWorktreeExist } from "./doesTaskWorktreeExist.ts";
import { checkTaskWorktreeSafe } from "./checkTaskWorktreeSafe.ts";
import { isTaskRunResumable } from "./isTaskRunResumable.ts";
import { createTaskWorktree } from "./createTaskWorktree.ts";
import { resetTaskWorktree } from "./resetTaskWorktree.ts";
import { generateTaskDocs } from "./generateTaskDocs.ts";
import { updateTaskDocs } from "./updateTaskDocs.ts";
import { initTaskSubmodules } from "./initTaskSubmodules.ts";
import { writeTaskExitNotes } from "./writeTaskExitNotes.ts";
import { recordTaskModifiedFiles } from "./recordTaskModifiedFiles.ts";
import { markTaskInactive } from "./markTaskInactive.ts";
import { releaseSourceRepoLock, buildLockOwner } from "./sourceRepoLock.ts";
import { loadPreparedTask, type PreparedTask } from "./preparedTask.ts";
import { absolutePathsSection } from "./promptSections.ts";
import { generateRunId, releaseTaskWorktreeLease } from "../prepareTasks.ts";
import type { Plan } from "./planArtifacts.ts";

// The receipt the "plan the task" agent box hands back: the plan file it drafted.
export type PlanFileReceipt = Plan;

// A task number that survived a box, or null when that box's path was not traversed.
type TaskNum = number | null;

// A box that splits. Exactly one column holds the task number; the other is null.
type InvalidValid = [invalid: TaskNum, valid: TaskNum];
type ClosedOpen = [closed: TaskNum, open: TaskNum];
type ClaimedTask = [unclaimed: TaskNum, claimed: TaskNum];
type BlockedUnblocked = [blocked: TaskNum, unblocked: TaskNum];
type WorktreePresence = [withWorktree: TaskNum, withoutWorktree: TaskNum];
type WorktreeSafety = [unsafe: TaskNum, safe: TaskNum];
type WorktreeResumability = [unresumable: TaskNum, resumable: TaskNum];

// The run identity every box shares. One runId per invocation, not per task, so the source-repo lock owner "runId:taskNumber" stays unique per task.
export type RunContext = { runId: string; projectRoot: string; sourceBranch: string };

export type ExitInfo = { exitType: string; exitNote: string };

// A box fed by two edges takes whichever of them was traversed.
const either = (a: TaskNum, b: TaskNum): TaskNum => a ?? b;

// A stop produces a skill body that does nothing except report why the run stopped.
const stop = (taskNumber: TaskNum, info: ExitInfo): string =>
    `Do nothing except report this line to the user, verbatim:\n\nTask ${taskNumber}: ${info.exitType} — ${info.exitNote}\n`;

// Split a task number into the two columns of a box, by which edge it took.
const split = (taskNumber: TaskNum, tookFirstEdge: boolean): [TaskNum, TaskNum] =>
    tookFirstEdge ? [taskNumber, null] : [null, taskNumber];

// Every box below re-derives the worktree path, because a box is given only a task number.
const worktreeOf = (taskNumber: number, ctx: RunContext): string => {
    const { worktree } = doesTaskWorktreeExist(taskNumber, ctx.projectRoot);
    if (worktree === null) throw new Error(`no worktree for task ${taskNumber}`);
    return worktree;
};

const getInvalidAndValidTask = (taskNumber: TaskNum, ctx: RunContext): InvalidValid => {
    if (taskNumber === null) return [null, null];
    const { valid } = isTaskNumberValid(taskNumber, ctx.projectRoot);
    return split(taskNumber, !valid);
};

// const getClosedAndOpenTask = (taskNumber: TaskNum, ctx: RunContext): ClosedOpen => {
//     if (taskNumber === null) return [null, null];
//     const { open } = isTaskOpen(taskNumber, ctx.projectRoot);
//     return split(taskNumber, !open);
// };

const claimTaskNumber = (taskNumber: TaskNum, ctx: RunContext): ClaimedTask => {
    if (taskNumber === null) return [null, null];
    const outcome = claimTask(taskNumber, ctx.runId, ctx.projectRoot);
    // Reaching this box means "is task open?" already passed, so the record must be there.
    if (outcome.status === "not-found") throw new Error(`task ${taskNumber} vanished from tasks.json before the claim`);
    return split(taskNumber, outcome.status !== "claimed");
};

const splitBlockedAndUnblockedTask = (taskNumber: TaskNum, ctx: RunContext): BlockedUnblocked => {
    if (taskNumber === null) return [null, null];
    const { blocked } = isTaskBlocked(taskNumber, ctx.projectRoot);
    return split(taskNumber, blocked);
};

const getWorktreeForTask = (taskNumber: TaskNum, ctx: RunContext): WorktreePresence => {
    if (taskNumber === null) return [null, null];
    const { exists } = doesTaskWorktreeExist(taskNumber, ctx.projectRoot);
    return split(taskNumber, exists);
};

const getUnsafeAndSafeWorktrees = (taskNumber: TaskNum, ctx: RunContext): WorktreeSafety => {
    if (taskNumber === null) return [null, null];
    const { safe } = checkTaskWorktreeSafe(taskNumber, worktreeOf(taskNumber, ctx));
    return split(taskNumber, !safe);
};

const getUnresumableAndResumableWorktree = (taskNumber: TaskNum, ctx: RunContext): WorktreeResumability => {
    if (taskNumber === null) return [null, null];
    const { resumable } = isTaskRunResumable(taskNumber, worktreeOf(taskNumber, ctx), ctx.runId, ctx.projectRoot);
    return split(taskNumber, !resumable);
};

const writeExitInfo = (taskNumber: TaskNum, info: ExitInfo, ctx: RunContext): void => {
    if (taskNumber === null) return;
    writeTaskExitNotes({ taskNumber, runId: ctx.runId, projectRoot: ctx.projectRoot, ...info });
};

const recordModifiedFiles = (taskNumber: TaskNum, ctx: RunContext): void => {
    if (taskNumber === null) return;
    const { worktree } = doesTaskWorktreeExist(taskNumber, ctx.projectRoot);
    recordTaskModifiedFiles({ taskNumber, runId: ctx.runId, projectRoot: ctx.projectRoot, worktree, sourceBranch: ctx.sourceBranch });
};

const markInactive = (taskNumber: TaskNum, ctx: RunContext): void => {
    if (taskNumber === null) return;
    markTaskInactive({ taskNumber, runId: ctx.runId, projectRoot: ctx.projectRoot });
};

const releaseWorktreeLeaseAndSourceLock = (taskNumber: TaskNum, ctx: RunContext): void => {
    if (taskNumber === null) return;
    const { worktree } = doesTaskWorktreeExist(taskNumber, ctx.projectRoot);
    if (worktree !== null) releaseTaskWorktreeLease({ worktreePath: worktree, runId: ctx.runId });
    releaseSourceRepoLock(ctx.projectRoot, buildLockOwner(ctx.runId, taskNumber));
};

const createWorktree = (taskNumber: TaskNum, ctx: RunContext): TaskNum => {
    if (taskNumber === null) return null;
    createTaskWorktree(taskNumber, ctx.runId, ctx.projectRoot);
    return taskNumber;
};

const resetWorktree = (taskNumber: TaskNum, ctx: RunContext): TaskNum => {
    if (taskNumber === null) return null;
    resetTaskWorktree(taskNumber, ctx.runId, ctx.projectRoot);
    return taskNumber;
};

const autoGenerateDocs = (taskNumber: TaskNum, ctx: RunContext): TaskNum => {
    if (taskNumber === null) return null;
    generateTaskDocs(taskNumber, worktreeOf(taskNumber, ctx), ctx.projectRoot);
    return taskNumber;
};

const updateAutoGeneratedDocs = (taskNumber: TaskNum, ctx: RunContext): TaskNum => {
    if (taskNumber === null) return null;
    updateTaskDocs(taskNumber, worktreeOf(taskNumber, ctx), ctx.projectRoot);
    return taskNumber;
};

const initSubmodulesRecursively = (taskNumber: TaskNum, ctx: RunContext): TaskNum => {
    if (taskNumber === null) return null;
    initTaskSubmodules({
        worktreePath: worktreeOf(taskNumber, ctx),
        taskNumber,
        runId: ctx.runId,
        projectRoot: ctx.projectRoot,
        stepId: "init-submodules",
    });
    return taskNumber;
};


// ---------------------------------------------------------------------------
// The planner agent's prompt, and the helpers only it uses.
// ---------------------------------------------------------------------------

const TESTS_FIELD_INSTRUCTION = `If TESTS_FIELD below is present and is not the literal string "skip", it holds an
example test the user wrote: put it into the plan's verification section as the concrete
check to run, expanded with a few extra cases covering the individual functions/subparts
it touches. Otherwise do not require TDD; write ordinary verification commands instead.`;

// Double-quoted for the read-file hook's parser, not a shell: a quoted run keeps a spaced path whole.
const readFileArgs = (paths: string[]) => paths.map((path) => `"${path}"`).join(" ");

const PLAN_TEMPLATE_PATH = fileURLToPath(new URL("../../plans/plan-template.json", import.meta.url));
const PLAN_OUTPUT_PATH = fileURLToPath(new URL("../../plans/plan-output-template.json", import.meta.url));
// Resolved here because the read-file hook stats the raw string and never expands a tilde.
const GUIDE = (name: string) => `${homedir()}/.claude/guides/${name}`;

// The template is valid JSON, so the task number is set here rather than left for the agent.
const planShape = (t: PreparedTask) => {
    const shape = JSON.parse(readFileSync(PLAN_TEMPLATE_PATH, "utf8"));
    shape.task = t.number;
    return JSON.stringify(shape, null, 2);
};

// ---------------------------------------------------------------------------
// plan — writes plan.json in the shape of plans/plan-template.json, spliced in below.
// ---------------------------------------------------------------------------

export function planPrompt(t: PreparedTask): string {
    const codexNotes = t.codexReviewNotes.trim() === "" ? "" : `
## CODEX'S PREVIOUS REVIEW NOTES

Codex reviewed your last plan and did not accept it. Its notes are as follows:

${t.codexReviewNotes.trim()}

Address every point above in the sections you write.
`;
    return `Invoke the skill \`/ponytail:ponytail ultra\` first.
${codexNotes}
## YOUR JOB

You are a read-only agent that is writing an implementation plan for task ${t.number} from \`.taskTools/tasks.json\`. 
The full task brief is below. 

## DESIRED OUTPUT 
The plan must be written to exactly \`${t.planFile}\`. 
The plan must be formatted in the exact shape shown under **FORMATTING THE PLAN** below.

## WHAT TO READ:

Invoke the skill, which puts the brief, the files this task owns, the guides you must follow,
and the return shape you must produce into your context:
\`\`\`
/read-file ${readFileArgs([t.briefFile, ...t.ownedFilePaths, GUIDE("planning.md"), GUIDE("tdd.md"), PLAN_OUTPUT_PATH])}
\`\`\`

${absolutePathsSection(t.repoRoot)}

Read the owned files — a plan that guesses at their contents will be rejected.
Follow \`~/.claude/guides/planning.md\` and write the plan as JSON to exactly \`${t.planFile}\`
Do not change any source file — this is planning only, not implementation.

## FORMATTING THE PLAN

Write the plan in exactly this shape, replacing every \`<...>\` with a real value:
\`\`\`json
${planShape(t)}
\`\`\`

## PLAN REQUIREMENTS

The plan must be exact enough and comprehensive enough that the implementer makes no discovery of its own:
- Name every edit by file path and line number.
- - Show each edit as a \`diff\`: mark each edit as \`old\`, \`new\`. 
- - show the exact text to remove or insert
- - sort the edits per file as highest line numbers first so edits do not shift the lines of later edits.  
- - Never say "insert at the end" or "replace the whole file" — show the exact text to remove and insert, and where.
- Account for every file this task owns: either its exact edit list, or the reason it needs no edit.
- Resolve every question while planning. 
- Write no conditional instruction
- no "re-check", 
- no "verify before editing", 
- no "if the live file disagrees", 
- no "trust the live file". 
- If you could not settle something, return outcome CLARIFY, not a fallback sentence in the plan.
- Quote only text you actually read. 
- Never describe an excerpt the brief does not contain.
- State the verification that proves the change worked, by writing the exact command used to produce the expected result.  This helps the implementer know that they're implementing correctly. 
- ${TESTS_FIELD_INSTRUCTION}

## WHEN TO STOP PLANNING

If:
- the plan needs to edit a file this task does not own, OR
- the plan needs to READ a file you were not given to write an exact plan, OR
- the task is unclear or no longer applies to the codebase: 

Then:
- do not write the plan file.
- Instead return outcome CLARIFY, with clarifyRequest naming exactly what you were not given.

Otherwise:
- write the plan file exactly at \`${t.planFile}\`
- return outcome PLAN.

## FORBIDDEN ACTIONS

You are forbidden from doing any of the following actions: 
- edit any file other than \`${t.planFile}\`; 
- to leave a decision for the implementer; 
- to write a plan step whose exact target you did not read. 

## ALLOWED ACTIONS

You are allowed to read every file the read-file skill put into your context, and nothing else.

## WHAT TO RETURN:
Return the shape given by \`${PLAN_OUTPUT_PATH}\`, which the read-file skill put into your context, replacing every \`<...>\` with a real value.

---- TESTS_FIELD (task's tests field; empty or "skip" means no TDD requirement) ----
${t.tests ?? "(none)"}`;
}

const createPlanningAgentPrompt = (taskNumber: TaskNum, shouldBeValidated: boolean, ctx: RunContext): string => {
    if (taskNumber === null) throw new Error("the planner phase reached \"plan the task\" with no task number");
    const prepared = loadPreparedTask(taskNumber, worktreeOf(taskNumber, ctx), ctx.projectRoot);
    const prompt = planPrompt(prepared);
    // ponytail: the codex review is the next phase's box, so validation is only announced here.
    return shouldBeValidated ? `${prompt}\nCodex reviews this plan before it is implemented.\n` : prompt;
};

export const skillBody = (taskNumber: number, shouldBeValidated: boolean, ctx: RunContext): string => {
    // check if tasks.json has a task with that number.
    const [invalidTaskNumber, validTaskNumber] = getInvalidAndValidTask(taskNumber, ctx); // "is task number valid?"
    if (invalidTaskNumber) {
        // No task record exists to write to, so this exit reports and stops.
        return stop(invalidTaskNumber, { exitType: "invalid-number", exitNote: "task number is in neither tasks.json nor completedTasks.json" });
    }
    const [blockedTaskNumber, unblockedTaskNumber] = splitBlockedAndUnblockedTask(validTaskNumber, ctx); // "is task blocked?"
    if (blockedTaskNumber) {
        // No task record exists to write to, so this exit reports and stops.
        return stop(blockedTaskNumber, { exitType: "blocked-number", exitNote: "task number is blocked" });
    }
    const [failedClaimedTask, claimedTask] = claimTaskNumber(unblockedTaskNumber, ctx); // "claim the task: mark it active in tasks.json"
    if (failedClaimedTask) {
        // The held claim belongs to another invocation's run, so this exit must not write to it.
        return stop(failedClaimedTask, { exitType: "already-active", exitNote: "a previous run left the claim held" });
    }
    
    const [taskWithExistingWorktree, taskWithoutExistingWorktree] = getWorktreeForTask(unblockedTaskNumber, ctx); // "does a worktree exist?"
    const taskWithNewWorktree = createWorktree(taskWithoutExistingWorktree, ctx); // "create a worktree"
    const [taskWithUnsafeWorktree, taskWithSafeWorktree] = getUnsafeAndSafeWorktrees(taskWithExistingWorktree, ctx); // "is the worktree safe to use?"
    const [taskWithUnresumableWorktree, tasksWithResumableWorktree] = getUnresumableAndResumableWorktree(taskWithUnsafeWorktree, ctx); // "is the previous run's work resumable?"
    const taskWithResetWorktree = resetWorktree(taskWithUnresumableWorktree, ctx); // "reset the worktree"
    const taskNeedingUpdatedAutoGeneratedDocs = either(taskWithSafeWorktree, tasksWithResumableWorktree);
    const taskWithUpdatedAutoGeneratedDocs = updateAutoGeneratedDocs(taskNeedingUpdatedAutoGeneratedDocs, ctx); // "update auto generated docs"

    const taskWithNewAutoGeneratedDocs = autoGenerateDocs(either(taskWithResetWorktree, taskWithNewWorktree), ctx); // "auto generate docs"
    const taskWithInitializedSubmodules = initSubmodulesRecursively(either(taskWithUpdatedAutoGeneratedDocs, taskWithNewAutoGeneratedDocs), ctx); // "init submodules recursively"

    const planningAgentPrompt = createPlanningAgentPrompt(taskWithInitializedSubmodules, shouldBeValidated, ctx); // "plan the task" using a subagent, validating it if necessary first.
    return planningAgentPrompt;
};

if (process.argv[1]?.endsWith("PlannerBodyEmitter.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as {
        taskNumber: number;
        shouldBeValidated?: boolean;
        runId?: string;
        projectRoot: string;
        sourceBranch?: string;
    };
    // Never defaulted to cwd: the source lock lives in projectRoot/.git, and a linked worktree's .git is a file, so a wrong root fails only at the last box of an exit.
    const projectRoot = input.projectRoot;
    const ctx: RunContext = {
        runId: input.runId ?? generateRunId(),
        projectRoot,
        sourceBranch:
            input.sourceBranch ??
            execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
    };
    process.stdout.write(skillBody(input.taskNumber, input.shouldBeValidated ?? false, ctx));
}
