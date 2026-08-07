# Task 69: Give blockedBy entries a reason: turn each entry into { taskNum, reason } and migrate legacy numbers during close-tasks

## User request

blockedBy entries get a 'reason' key: .blockedBy: { .taskNum: number, .reason: string }.

`blockedBy` is currently an array of bare task numbers, so nothing records WHY a task is blocked. Change every entry to an object `{ taskNum: number, reason: string }`.

Read sites — five scripts, all sharing the same shape (coerce to array, keep only blocker numbers still open, never mutate the file). Each must pull `taskNum` out of the object instead of coercing the element itself:
- scripts/checkBlockers.ts:17 — `(Array.isArray(task?.blockedBy) ? task.blockedBy : []).map(Number).filter(b => openNumbers.has(b))`
- scripts/prepareTasks.ts:38-39 — `const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : []` then `.filter((number): number is number => openNumbers.has(...))`
- scripts/runStartup.ts:13-14 — casts to `number[]`, so the type annotation changes too
- scripts/taskStats.ts:25-26 — `.map(Number).filter(n => openNumbers.has(n))`
- scripts/getTaskDetails.ts:20 — renders `` [blockedBy: ${t.blockedBy.join(",")}] ``; with objects a bare join produces `[object Object]`, so this must map to taskNum, and it is the natural place to surface the new reason text in the listing.

Write site — scripts/unblockDependents.ts is the only script that mutates `blockedBy` in tasks.json (line 17 `if (!Array.isArray(t.blockedBy)) continue`, line 18 `t.blockedBy.filter(n => !closed.has(Number(n)))`, line 21 `delete t.blockedBy` when empty, line 22 reassign, line 25 the report string). Filtering must compare `closed.has(entry.taskNum)` and must preserve the surviving entries' `reason` values untouched.

Migration decision: convert legacy bare-number entries as a one-time upgrade performed during a `close-tasks` invocation, not as a standalone migration script and not as permanent dual-shape tolerance in the readers. The close path already rewrites tasks.json via unblockDependents.ts (wired in per skills/close-tasks/SKILL.md:20), so the upgrade rides along there: on each close run, any `blockedBy` element that is still a plain number is rewritten to `{ taskNum: <that number>, reason: "<placeholder>" }` before the closed-number filter runs. Readers should therefore be written against the object shape only. Note open task #64 is replacing the hand-edited close-tasks flow with a new scripts/closeTasks.ts — this task is blocked on it so the migration lands in the final close-tasks surface rather than in code #64 is about to rewrite.

Schema and docs to update:
- skills/create-task/template/taskTemplate.json:9 — the canonical schema line, currently `"blockedBy": [<task numbers of any tasks that must be completed first; omit the field if none>]`. This is the ONLY schema/doc file that spells out the field shape (grep confirmed no `blockedBy` text in skills/create-task/SKILL.md or hooks/). It must describe the object form and require a reason.
- skills/close-tasks/SKILL.md:20 — prose says the script "removes the closed numbers from every remaining task's `blockedBy` array"; extend to mention the legacy-number upgrade.
- skills/goal-tasks/SKILL.md:16 and skills/tackle-unblocked-tasks/SKILL.md:3 mention blockedBy only as ordering/emptiness, so they need at most a wording touch-up.

Existing data: two open tasks currently carry bare numbers — task 36 has `blockedBy: [35]` and task 62 has `blockedBy: [61]`. Both must survive the migration with their taskNum intact.

Unrelated name collision — do NOT touch scripts/approvalReadiness.ts or tests/approvalReadiness.test.ts. They have a local `blockedBy` property of type `ApprovalBlockReason[]` on an approval-readiness result object; it is not the task-record field.

### scripts/checkBlockers.ts

```
// Reports which of the requested task numbers are blocked by still-open tasks.
// Output goes to stdout because tackle-tasks injects it via a !`node ...` command.
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

const pair = resolveTaskFiles(process.cwd());
const openTasks = readTaskFile(pair.tasksPath);
const openNumbers = new Set(openTasks.map(t => t.taskNumber));

// --unblocked: print only the unblocked task numbers, space-separated, so the
// skill preamble can pipe them straight into getTaskDetails.ts.
const unblockedOnly = process.argv.includes("--unblocked");
// No task numbers -> check every open task (mirrors getTaskDetails' no-arg listing).
const named = leadingTaskNumbers(process.argv.slice(2).filter(a => a !== "--unblocked"));
const requested = named.length > 0 ? named : openTasks.map(t => t.taskNumber);
const openBlockersOf = (n: number) => {
  const task = openTasks.find(t => t.taskNumber === n);
  return (Array.isArray(task?.blockedBy) ? task.blockedBy : []).map(Number).filter(b => openNumbers.has(b));
};
if (unblockedOnly) {
  process.stdout.write(requested.filter(n => openBlockersOf(n).length === 0).join(" ") + "\n");
} else {
  const lines = requested.map(n => {
    const blockers = openBlockersOf(n);
    return blockers.length > 0 ? `task ${n}: BLOCKED by open task(s) ${blockers.join(", ")}` : `task ${n}: unblocked`;
  });
  process.stdout.write((lines.length > 0 ? lines.join("\n") : "no task numbers given") + "\n");
}

```

### scripts/prepareTasks.ts

```
// Writes task briefs, creates one worktree per file-disjoint group, prints WorkflowArguments. CLI entry point at bottom.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bootstrapRepositoryManifest } from "./manifestBootstrap.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "./repositoryManifest.ts";
import type { TaskGroup, TaskGroupScope } from "./taskGroups.ts";
import { groupTasksByFileOverlap } from "./taskGroups.ts";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { collectRepositorySources, createBranchInEveryRepository, currentBranchName, submodulePaths, type RepositorySource } from "./repositoryBranches.ts";

export type PreparedTask = {
    number: number;
    briefFile: string;
    planFile: string;
    files: string[];
};

export type PreparedGroup = {
    groupId: number;
    worktree: string;
    branch: string;
    scope: TaskGroupScope;
    tasks: PreparedTask[];
};

export type WorkflowArguments = {
    repo: string;
    typecheckCommand: string;
    groups: PreparedGroup[];
    repositorySources: RepositorySource[];
};

const DEFAULT_TYPECHECK_COMMAND = "npx tsc --noEmit";

function getOpenBlockers(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    return blockedBy.filter((number): number is number => openNumbers.has(number as number));
}

// Never defaults to every open task: this creates worktrees and fans out agents.
export function selectRequestedTasks(openTasks: TaskRecord[], requestedNumbers: number[]): TaskRecord[] {
    if (requestedNumbers.length === 0) {
        throw new Error("no task numbers given; pass a JSON array with no spaces, e.g. [268,270]");
    }
    const openNumbers = new Set(openTasks.map((task) => task.taskNumber));
    const missingNumbers = requestedNumbers.filter((number) => !openNumbers.has(number));
    if (missingNumbers.length > 0) {
        throw new Error(`not open in tasks.json: ${missingNumbers.join(", ")}`);
    }
    const requestedTasks = openTasks.filter((task) => requestedNumbers.includes(task.taskNumber));
    const runnableTasks = requestedTasks.filter((task) => getOpenBlockers(task, openNumbers).length === 0);
    const undeclaredNumbers = runnableTasks.filter((task) => declaredFiles(task).length === 0).map((task) => task.taskNumber);
    if (undeclaredNumbers.length > 0) {
        const numbers = undeclaredNumbers.join(", ");
        throw new Error(
            `these tasks declare no "files" and cannot be planned or implemented: ${numbers}. `
            + `A task's "files" array is both the worker's ownership fence and the key that decides `
            + `what runs in parallel, so it cannot be inferred at run time. `
            + `Run /taskTools:update-task-files [${undeclaredNumbers.join(",")}] to add them, `
            + `or revise the tasks first.`,
        );
    }
    return runnableTasks;
}

export function generateRunId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function resolveMergeScriptPath(): string {
    return join(import.meta.dirname, "mergeTaskWorktrees.ts");
}

// The merge script reads its bulky arguments from here so no agent has to retype them.
export function resolveRunArgumentsPath(repoRoot: string): string {
    return join(repoRoot, ".taskTools", "run-arguments.json");
}

// Step 6 writes the run's outcome counts and receipts here rather than shell-quoting them.
export function resolveRunOutcomesPath(repoRoot: string): string {
    return join(repoRoot, ".taskTools", "run-outcomes.json");
}

// Step 6 drops the earlier steps' return values here verbatim; runMergePhase.ts derives the counts.
export function resolveStepOutputsPath(repoRoot: string): string {
    return join(repoRoot, ".taskTools", "run-steps.json");
}

export function resolveMergePhaseScriptPath(): string {
    return join(import.meta.dirname, "runMergePhase.ts");
}

function branchNameForGroup(groupId: number): string {
    return `task-group-${groupId}`;
}

function declaredFiles(task: TaskRecord): string[] {
    return Array.isArray(task.files) ? (task.files as string[]) : [];
}

export function writeTaskBriefFile(task: TaskRecord, repoRoot: string): string {
    const briefFile = join(repoRoot, "plans", `brief-${task.taskNumber}.md`);
    mkdirSync(dirname(briefFile), { recursive: true });
    const fileSections = declaredFiles(task).map((file) => {
        const fullPath = join(repoRoot, file);
        if (!existsSync(fullPath)) return `### ${file}\n\n(missing: file not found on disk)\n`;
        return `### ${file}\n\n\`\`\`\n${readFileSync(fullPath, "utf8")}\n\`\`\`\n`;
    });
    const content = [
        `# Task ${task.taskNumber}: ${task.title ?? ""}`,
        "",
        ...(task.userDescription ? [`## User request\n\n${task.userDescription}`, ""] : []),
        task.description ?? "",
        "",
        ...fileSections,
    ].join("\n");
    writeFileSync(briefFile, content);
    return briefFile;
}

// `git worktree add` leaves submodule directories empty; a worker needs them populated.
function initializeSubmodulesInWorktree(worktreePath: string): void {
    if (!existsSync(join(worktreePath, ".gitmodules"))) return;
    execFileSync(
        "git",
        ["-C", worktreePath, "submodule", "update", "--init", "--recursive"],
        { stdio: ["ignore", "ignore", "inherit"] },
    );
}

export function createWorktreeForGroup(repoRoot: string, group: TaskGroup): string {
    const worktreePath = join(tmpdir(), "taskTools-wt", basename(repoRoot), `group-${group.groupId}`);
    const branchName = branchNameForGroup(group.groupId);
    if (existsSync(worktreePath)) {
        // A worktree left by an earlier run holds that run's commits; re-base it on the source branch tip.
        execFileSync(
            "git",
            ["-C", worktreePath, "checkout", "--force", "-B", branchName, currentBranchName(repoRoot)],
            { stdio: "ignore" },
        );
    } else {
        mkdirSync(dirname(worktreePath), { recursive: true });
        execFileSync(
            "git",
            ["-C", repoRoot, "worktree", "add", "-B", branchName, worktreePath, "HEAD"],
            { stdio: "ignore" },
        );
    }
    initializeSubmodulesInWorktree(worktreePath);
    createBranchInEveryRepository(worktreePath, ["", ...submodulePaths(worktreePath)], branchName);
    return worktreePath;
}

export function buildWorkflowArguments(
    repoRoot: string,
    typecheckCommand: string,
    groups: TaskGroup[],
): WorkflowArguments {
    const repositorySources = collectRepositorySources(repoRoot);
    const preparedGroups: PreparedGroup[] = groups.map((group) => ({
        groupId: group.groupId,
        worktree: createWorktreeForGroup(repoRoot, group),
        branch: branchNameForGroup(group.groupId),
        scope: group.scope,
        tasks: group.taskNumbers.map((number) => ({
            number,
            briefFile: join(repoRoot, "plans", `brief-${number}.md`),
            planFile: join(repoRoot, "plans", `task-${number}-plan.md`),
            files: group.filePaths,
        })),
    }));
    return { repo: repoRoot, typecheckCommand, groups: preparedGroups, repositorySources };
}

function loadRepositoryManifest(repoRoot: string): RepositoryManifest {
    const result = bootstrapRepositoryManifest(repoRoot);
    if (result.refused) {
        throw new Error(`repository at "${repoRoot}" needs branch resolution before it can be discovered`);
    }
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: result.occurrenceGraph };
}

function hasOriginRemote(repoRoot: string): boolean {
    try {
        execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const requestedNumbers = leadingTaskNumbers(process.argv.slice(2));
    let tasks: TaskRecord[];
    try {
        if (!hasOriginRemote(repoRoot)) {
            throw new Error("this repository does not have an origin remote. set one to continue to use 'tackle-tasks'");
        }
        tasks = selectRequestedTasks(openTasks, requestedNumbers);
    } catch (error) {
        process.stderr.write(`prepareTasks: ${(error as Error).message}\n`);
        process.exit(1);
    }
    for (const task of tasks) writeTaskBriefFile(task, repoRoot);
    const manifest = loadRepositoryManifest(repoRoot);
    const groups = groupTasksByFileOverlap(tasks, manifest);
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, groups);
    // startTimestamp is stamped here because workflow scripts cannot call Date.now().
    const pipelineArguments = {
        ...workflowArguments,
        runId: generateRunId(),
        startTimestamp: new Date().toISOString(),
        mergeScript: resolveMergeScriptPath(),
        repositoryManifest: manifest,
    };
    const argumentsFile = resolveRunArgumentsPath(repoRoot);
    mkdirSync(dirname(argumentsFile), { recursive: true });
    writeFileSync(argumentsFile, JSON.stringify(pipelineArguments));
    process.stdout.write(JSON.stringify({
        ...pipelineArguments,
        stepOutputsFile: resolveStepOutputsPath(repoRoot),
        mergeCommand: `node "${resolveMergePhaseScriptPath()}"`,
    }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();

```

### scripts/runStartup.ts

```
// Startup entry point: read-only discovery, then a gated mutating-preparation phase.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";

export type DiscoveryResult = {
    openTasks: TaskRecord[];
    blockedTaskNumbers: number[];
    unblockedTaskNumbers: number[];
};

function openBlockersOf(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? (task.blockedBy as number[]) : [];
    return blockedBy.filter((n) => openNumbers.has(n));
}

// Read-only: reads tasks.json only. No fs writes, no git, no worktree/branch creation.
export function discoverStartupState(cwd: string = process.cwd()): DiscoveryResult {
    const pair = resolveTaskFiles(cwd);
    const openTasks = readTaskFile(pair.tasksPath);
    const openNumbers = new Set(openTasks.map((t) => t.taskNumber));
    const blockedTaskNumbers: number[] = [];
    const unblockedTaskNumbers: number[] = [];
    for (const task of openTasks) {
        const bucket = openBlockersOf(task, openNumbers).length > 0 ? blockedTaskNumbers : unblockedTaskNumbers;
        bucket.push(task.taskNumber);
    }
    return { openTasks, blockedTaskNumbers, unblockedTaskNumbers };
}

export type HookCheckResult = { enabled: boolean; reason?: string };

type HookCommand = { command?: string; enabled?: boolean };
type HookEntry = { hooks?: HookCommand[] };
type HooksFile = { hooks?: Record<string, HookEntry[]> };

const RELATED_TESTS_ENTRY_POINT = "scripts/relatedTests.ts";

// Confirms the copied taskTools test hook is registered in hooks/hooks.json (never any settings.json) and not disabled.
export function confirmTestHookEnabled(
    hooksJsonPath: string = join(process.cwd(), "hooks", "hooks.json"),
): HookCheckResult {
    let parsed: HooksFile;
    try {
        parsed = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
    } catch {
        return { enabled: false, reason: `hooks/hooks.json not found or unreadable at ${hooksJsonPath}` };
    }
    const match = Object.values(parsed.hooks ?? {})
        .flat()
        .flatMap((entry) => entry.hooks ?? [])
        .find((hook) => hook.command?.includes(RELATED_TESTS_ENTRY_POINT));
    if (!match) {
        return { enabled: false, reason: `${RELATED_TESTS_ENTRY_POINT} is not registered in hooks/hooks.json` };
    }
    if (match.enabled === false) {
        return { enabled: false, reason: `${RELATED_TESTS_ENTRY_POINT} is registered but disabled` };
    }
    return { enabled: true };
}

export type MutatingStep = () => void;
export type MutatingPreparationResult = { stopped: boolean; reason?: string; stepsRun: number };

// Gate precedes every step individually, not just the first.
export function runGatedMutatingSteps(
    steps: MutatingStep[],
    confirmHook: () => HookCheckResult = confirmTestHookEnabled,
): MutatingPreparationResult {
    let stepsRun = 0;
    for (const step of steps) {
        const check = confirmHook();
        if (!check.enabled) return { stopped: true, reason: check.reason, stepsRun };
        step();
        stepsRun++;
    }
    return { stopped: false, stepsRun };
}

export type RunStartupOptions = {
    cwd?: string;
    mutatingSteps?: MutatingStep[];
    confirmHook?: () => HookCheckResult;
};

export type RunStartupResult = {
    discovery: DiscoveryResult;
    stopped: boolean;
    reason?: string;
    stepsRun: number;
};

// Discovery never calls confirmHook or a step; mutating steps are owned elsewhere, gated here.
export function runStartup(options: RunStartupOptions = {}): RunStartupResult {
    const discovery = discoverStartupState(options.cwd);
    const { stopped, reason, stepsRun } = runGatedMutatingSteps(options.mutatingSteps ?? [], options.confirmHook);
    return { discovery, stopped, reason, stepsRun };
}

```

### scripts/taskStats.ts

```
// Aggregates tasks.json and completedTasks.json: closure velocity, files coverage, blocking, and the parallelism a tackle-tasks run would get.
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { declaredFiles, groupTasksByFileOverlap } from "./taskGroups.ts";

export type TaskStats = {
    openCount: number;
    blockedCount: number;
    unblockedCount: number;
    openWithFiles: number;
    openWithoutFiles: number;
    completedCount: number;
    completedWithCommitHashes: number;
    closedLast7: number;
    closedLast30: number;
    busiestDay: { date: string; count: number } | null;
    forecastTaskCount: number;
    groupCount: number;
    largestGroupSize: number;
    contendedFiles: { path: string; taskCount: number }[];
};

const dayNumber = (isoDate: string) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);

function openBlockersOf(task: TaskRecord, openNumbers: Set<number>): number[] {
    const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    return blockedBy.map(Number).filter(n => openNumbers.has(n));
}

function countClosedWithin(completed: TaskRecord[], today: string, days: number): number {
    const cutoff = dayNumber(today) - days + 1;
    return completed.filter(t => {
        const date = typeof t.completionDate === "string" ? t.completionDate : "";
        return date !== "" && dayNumber(date) >= cutoff && dayNumber(date) <= dayNumber(today);
    }).length;
}

function findBusiestDay(completed: TaskRecord[]): { date: string; count: number } | null {
    const perDay = new Map<string, number>();
    for (const task of completed) {
        if (typeof task.completionDate !== "string") continue;
        perDay.set(task.completionDate, (perDay.get(task.completionDate) ?? 0) + 1);
    }
    const ranked = [...perDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return ranked.length > 0 ? { date: ranked[0][0], count: ranked[0][1] } : null;
}

function rankContendedFiles(tasks: TaskRecord[]): { path: string; taskCount: number }[] {
    const perFile = new Map<string, number>();
    for (const task of tasks) {
        for (const file of declaredFiles(task)) perFile.set(file, (perFile.get(file) ?? 0) + 1);
    }
    return [...perFile.entries()]
        .filter(([, count]) => count > 1)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([path, taskCount]) => ({ path, taskCount }));
}

export function computeTaskStats(open: TaskRecord[], completed: TaskRecord[], today: string): TaskStats {
    const openNumbers = new Set(open.map(t => t.taskNumber));
    const unblocked = open.filter(t => openBlockersOf(t, openNumbers).length === 0);
    // tackle-tasks refuses blocked tasks and tasks declaring no files, so the forecast uses the same gate.
    const forecastable = unblocked.filter(t => declaredFiles(t).length > 0);
    const groups = forecastable.length > 0 ? groupTasksByFileOverlap(forecastable) : [];

    return {
        openCount: open.length,
        blockedCount: open.length - unblocked.length,
        unblockedCount: unblocked.length,
        openWithFiles: open.filter(t => declaredFiles(t).length > 0).length,
        openWithoutFiles: open.filter(t => declaredFiles(t).length === 0).length,
        completedCount: completed.length,
        completedWithCommitHashes: completed.filter(t => Array.isArray(t.commitHashes) && t.commitHashes.length > 0).length,
        closedLast7: countClosedWithin(completed, today, 7),
        closedLast30: countClosedWithin(completed, today, 30),
        busiestDay: findBusiestDay(completed),
        forecastTaskCount: forecastable.length,
        groupCount: groups.length,
        largestGroupSize: groups.reduce((n, g) => Math.max(n, g.taskNumbers.length), 0),
        contendedFiles: rankContendedFiles(open),
    };
}

export function formatTaskStats(stats: TaskStats): string {
    const lines = [
        `${stats.openCount} open (${stats.unblockedCount} unblocked, ${stats.blockedCount} blocked)`,
        `${stats.openWithFiles} of ${stats.openCount} open tasks declare files — ${stats.openWithoutFiles} would be refused by tackle-tasks`,
        `${stats.completedCount} completed, ${stats.completedWithCommitHashes} with commit hashes recorded`,
        `closed: ${stats.closedLast7} in the last 7 days, ${stats.closedLast30} in the last 30`,
    ];
    if (stats.busiestDay) lines.push(`busiest day: ${stats.busiestDay.date} (${stats.busiestDay.count} closed)`);
    lines.push(
        stats.forecastTaskCount > 0
            ? `parallelism: ${stats.forecastTaskCount} runnable tasks would form ${stats.groupCount} groups, largest ${stats.largestGroupSize} tasks (serialized within a group)`
            : `parallelism: no runnable tasks — nothing to group`,
    );
    if (stats.contendedFiles.length > 0) {
        lines.push("contended files (each shared task serializes):");
        for (const file of stats.contendedFiles) lines.push(`  ${file.path} — ${file.taskCount} tasks`);
    }
    return lines.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const pair = resolveTaskFiles(process.cwd());
    const today = new Date().toISOString().slice(0, 10);
    const stats = computeTaskStats(readTaskFile(pair.tasksPath), readTaskFile(pair.completedTasksPath), today);
    process.stdout.write(formatTaskStats(stats));
}

```

### scripts/getTaskDetails.ts

```
// Task lookup helpers, plus a CLI that prints them to stdout for skill injection.
import { type TaskRecord, leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export function describeTask(taskNumber: number, openTasks: TaskRecord[], completedTasks: TaskRecord[]): string {
  const open = openTasks.find(t => t.taskNumber === taskNumber);
  if (open) return `task ${taskNumber} (OPEN):\n${JSON.stringify(open, null, 2)}`;
  const completed = completedTasks.find(t => t.taskNumber === taskNumber);
  if (completed) return `task ${taskNumber} (COMPLETED):\n${JSON.stringify(completed, null, 2)}`;
  return `task ${taskNumber}: not found in tasks.json or completedTasks.json`;
}

export function listTaskTitles(tag: string, tasks: TaskRecord[]): string[] {
  return tasks.map(t => {
    const blockers = Array.isArray(t.blockedBy) && t.blockedBy.length > 0 ? ` [blockedBy: ${t.blockedBy.join(",")}]` : "";
    return `${tag} ${t.taskNumber}: ${t.title}${blockers}`;
  });
}

export function readTaskLists(projectRoot: string = process.cwd()): {
  openTasks: TaskRecord[];
  completedTasks: TaskRecord[];
} {
  const pair = resolveTaskFiles(projectRoot);
  return { openTasks: readTaskFile(pair.tasksPath), completedTasks: readTaskFile(pair.completedTasksPath) };
}

// Open tasks win over completed ones, matching describeTask's lookup order.
export function findTask(taskNumber: number, projectRoot: string = process.cwd()): TaskRecord | undefined {
  const { openTasks, completedTasks } = readTaskLists(projectRoot);
  return openTasks.find(t => t.taskNumber === taskNumber) ?? completedTasks.find(t => t.taskNumber === taskNumber);
}

export function taskDetailsReport(taskNumbers: number[], projectRoot: string = process.cwd()): string {
  const { openTasks, completedTasks } = readTaskLists(projectRoot);
  const report =
    taskNumbers.length === 0
      ? [...listTaskTitles("OPEN", openTasks), ...listTaskTitles("DONE", completedTasks)]
      : taskNumbers.map(n => describeTask(n, openTasks, completedTasks));
  return report.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(taskDetailsReport(leadingTaskNumbers(process.argv.slice(2))));
}

```

### scripts/unblockDependents.ts

```
// Removes the given (just-closed) task numbers from every tasks.json entry's
// blockedBy array, dropping the field when it empties. Invoked by the
// close-tasks skill after moving closed tasks to completedTasks.json.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

const closed = new Set((process.argv.slice(2).join(" ").match(/\d+/g) ?? []).map(Number));
if (closed.size === 0) {
  process.stderr.write("usage: node unblockDependents.ts <taskNumber...>\n");
  process.exit(1);
}

const { tasksPath } = resolveTaskFiles(process.cwd());
const tasks = readTaskFile(tasksPath);
const unblocked: number[] = [];
for (const t of tasks) {
  if (!Array.isArray(t.blockedBy)) continue;
  const remaining = t.blockedBy.filter(n => !closed.has(Number(n)));
  if (remaining.length === t.blockedBy.length) continue;
  unblocked.push(t.taskNumber);
  if (remaining.length === 0) delete t.blockedBy;
  else t.blockedBy = remaining;
}
if (unblocked.length > 0) writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
process.stdout.write((unblocked.length > 0 ? `removed closed task(s) from blockedBy of task(s): ${unblocked.join(", ")}` : "no blockedBy references to the closed task(s)") + "\n");

```

### skills/create-task/template/taskTemplate.json

```
{
  "taskNumber": <the injected number above>,
  "version": "<the injected commit hash above>",
  "title": "<short summary of the task>",
  "userDescription": "<$ARGUMENTS verbatim, exactly as typed — never edited, summarized, or reworded>",
  "description": "<only the agent's derived, fleshed-out understanding: file paths, line numbers, root-cause findings, constraints, and decisions gathered while writing the task; must not restate the raw prompt>",
  "files": ["<repo-relative path this task will touch>"],
  "tests": "<the user's example test as prose or pseudocode, or the literal string skip>",
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
  "blockedBy": [<task numbers of any tasks that must be completed first; omit the field if none>]
}

```

### skills/close-tasks/SKILL.md

```
---
name: close-tasks
description: manually close the named task numbers — move them from tasks.json to completedTasks.json with commit hashes
argument-hint: "[N,N,...] <why they are done>"
allowed-tools: Bash(git add *), Bash(git log *), Bash(node *)
---

- tasks to close: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" '$ARGUMENTS'`

Invocation format: the task numbers come first as a JSON array with **no spaces** — `[268,270,281]` — and everything after them is free-text reasoning. The script reads the whole argument string and stops at the first token that is not part of the array, so the reasoning is ignored by it. Avoid apostrophes and backticks in that reasoning; it reaches the shell inside single quotes. If the details above don't cover every task number named in `$ARGUMENTS` — a full listing instead, or only the first few — the invoker skipped the array form or put spaces in it: re-run the script yourself with all the numbers before continuing.

`$ARGUMENTS` holds the whole invocation, reasoning included, and may attribute reasons per task (`#268 fixed by X, #270 verified by user`).

Before archiving anything, run the project's verification once for the whole batch: typecheck plus the full test suite, and the repo's stated UI/browser verification if any closing task touched UI. If failures trace to the work being closed, fix them, re-stage the fixes, and re-run until green — only then archive. This is a regression gate, not a re-litigation of doneness.

The decision that these tasks are done has already been made (by the user, or by the skill that invoked this one) — do not re-litigate it. Before closing, search git history for the commit(s) that resolved each task; use an empty array for a task only if none can be identified. Close every listed OPEN task in exactly one invocation of `node "${CLAUDE_PLUGIN_ROOT}/scripts/closeTasks.ts" '[N,N,...]' '<note>' '<hashes>'` — never split the batch across calls: the first argument is every listed task number as one no-space JSON array. The second argument is either one sentence of closure reasoning shared by every task number in that array, or — when tasks in the same call need different reasoning — a no-space JSON object mapping each task number to its own sentence, e.g. `{"64":"fixed by abc123","65":"verified by user"}`; use the invoker's reasoning for that specific task where they gave one, their general reasoning otherwise, and "closed manually by user" if they gave none. The third argument is optional and follows the same shared-vs-per-task shape for the commit hashes found above: a no-space JSON array shared by every task in the call, e.g. `["abc123"]`, or a no-space JSON object mapping each task number to its own array, e.g. `{"64":["abc123"],"65":[]}`; omit this argument (or pass `[]`) only when no task in the call has any commits to record. Use the shared string/array forms only when every task in the batch has identical reasoning and hashes; otherwise use the per-task JSON object forms. Either way it is one call. The script writes today's date as `completionDate` and the resolved `closureNote`/`commitHashes` onto each closed task's record, splices it out of `tasks.json`, appends it to `completedTasks.json`, and reports which numbers it closed and which it skipped (already COMPLETED or not found in either file) — relay the skipped ones to the user.

Then unblock dependents with one run of `node "${CLAUDE_PLUGIN_ROOT}/scripts/unblockDependents.ts" '<the task numbers as a no-space JSON array>'` — keep the quotes, or the shell treats the array as a glob. It removes the closed numbers from every remaining task's `blockedBy` array and reports what it unblocked.

Stage the changes but do not commit. Provide a short commit message to the user, similar to "Closed tasks [268,270,281]" or "Closed task [268]", naming the numbers you actually closed.

If a spec document references these task numbers, mark those items done in the spec.

```

### skills/goal-tasks/SKILL.md

```
---
name: goal-tasks
description: interview the user to define the project goal, produce a testable spec at specs/SPEC.md, and create ordered tasks that achieve it
argument-hint: "<project goal>"
allowed-tools: Bash(git add *)
---

Standing rule for every step below: if the user is vague or unsure, use AskUserQuestion to fill specific gaps, or `/grill-me` for open-ended direction-setting.

1. Interview the user to find the real goal of this project.

2. Draft the spec at `specs/SPEC.md` in the target repo, following the template at `${CLAUDE_PLUGIN_ROOT}/skills/goal-tasks/templates/SPEC.md`. Spec items must be concrete and verifiable via tests. Record decisions the user has explicitly verified under Key Decisions. Leave each item's `Tasks:` line empty for now.

3. Confirm the goal, spec items, and key decisions with the user. Do not create any tasks until the user agrees.

4. Use `/create-task` to create granular tasks that, when all are completed, achieve the goal. Encode order with `blockedBy` so progress toward the goal is measurable. Each task should be completable in under 20 minutes and at most ~200 lines of code — split larger spec items into multiple tasks, merge trivial ones. Populate `files` with the repo-relative paths each task will touch; omit it if genuinely undeterminable.

5. Backfill the created task numbers into each spec item's `Tasks:` line.

6. Stage `specs/SPEC.md` and `tasks.json`. Do not commit.

`specs/SPEC.md` is a living document: `/close-tasks` marks items done as tasks complete, and `/create-task` appends new task numbers to the relevant item.

```

### skills/tackle-unblocked-tasks/SKILL.md

```
---
name: tackle-unblocked-tasks
description: tackle every open task in tasks.json whose blockedBy array is empty, in ascending task-number order
---
- `$tasks`: !``
- `$unblockedTaskNumbers`: !`u=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" --unblocked '$tasks'); [ -n "$u" ] && echo "[$(echo $u | tr ' ' '\n' | sort -n | paste -sd, -)]" || echo "none"`

If the line above says `none`, report that every open task is blocked and stop.

otherwise:
Invoke the `tackle-tasks $unblockedTaskNumbers valid` skill.
example: `[30,32,35] valid`. 
Pass it verbatim; do not re-derive or filter it.


```

### tests/checkBlockers.test.ts

```
// Behavioral checks for checkBlockers.ts: a requested task is BLOCKED only when
// its blockedBy lists task numbers still present in tasks.json; blockers that
// were already closed don't count.
// Run with: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "checkBlockers.ts");

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-checkBlockers-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "open blocker" },
      { taskNumber: 2, title: "blocked by open task", blockedBy: [1] },
      { taskNumber: 4, title: "blocked only by closed task", blockedBy: [3] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 3, title: "closed blocker" }]));
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("flags open blockers, ignores closed ones, passes unblocked tasks", () => {
  const out = runScript(makeProjectRoot(), "2", "4", "1");
  assert.match(out, /task 2: BLOCKED by open task\(s\) 1/);
  assert.match(out, /task 4: unblocked/);
  assert.match(out, /task 1: unblocked/);
});

test("--unblocked prints only unblocked numbers, space-separated", () => {
  const out = runScript(makeProjectRoot(), "--unblocked", "2", "4", "1");
  assert.equal(out, "4 1\n");
});

test("no task numbers checks every open task", () => {
  const out = runScript(makeProjectRoot());
  assert.match(out, /task 1: unblocked/);
  assert.match(out, /task 2: BLOCKED by open task\(s\) 1/);
  assert.match(out, /task 4: unblocked/);
});

test("non-numeric args like 'valid' are ignored", () => {
  const out = runScript(makeProjectRoot(), "2", "valid");
  assert.equal(out, "task 2: BLOCKED by open task(s) 1\n");
});

test("digits after prose are not task numbers, even as one quoted string", () => {
  const out = runScript(makeProjectRoot(), "2 valid see task 4 from 2026-07-21");
  assert.equal(out, "task 2: BLOCKED by open task(s) 1\n");
});

```

### tests/prepareTasks.test.ts

```
// Behavioral checks for prepareTasks.ts: brief writing, worktree creation, workflow args.  Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
    buildWorkflowArguments,
    createWorktreeForGroup,
    generateRunId,
    resolveMergeScriptPath,
    selectRequestedTasks,
    writeTaskBriefFile,
} from "../scripts/prepareTasks.ts";
import type { TaskGroup } from "../scripts/taskGroups.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "prepare-tasks-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function makeTempRepoWithLocalSubmodule(): { repoRoot: string; submoduleOrigin: string } {
    const submoduleOrigin = makeTempRepoWithCommit();
    writeFileSync(join(submoduleOrigin, "inner.txt"), "SUBMODULE-MARKER\n");
    git(submoduleOrigin, "add", "inner.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "inner");
    const repoRoot = makeTempRepoWithCommit();
    // git >=2.38 blocks file-transport submodules; repo config is ignored here, env is not.
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(repoRoot, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(repoRoot, "commit", "-q", "-m", "add submodule");
    return { repoRoot, submoduleOrigin };
}

test("test_writeTaskBriefFileEmbedsTheDeclaredFileContents", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "fileA.txt"), "MARKER-abc123\n");
    const task = { taskNumber: 1, title: "t1", description: "do the thing", files: ["fileA.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    assert.equal(briefFile, join(repoRoot, "plans", "brief-1.md"));
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /do the thing/);
    assert.match(text, /MARKER-abc123/);
});

test("test_writeTaskBriefFileOmitsMissingFilesWithoutThrowing", () => {
    const repoRoot = makeTempRepoWithCommit();
    const task = { taskNumber: 2, title: "t2", description: "desc", files: ["missing.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /missing\.txt/);
    assert.match(text, /missing/i);
});

test("test_createWorktreeForGroupCreatesACheckoutOnItsOwnBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    assert.equal(existsSync(worktreePath), true);
    const branch = git(worktreePath, "branch", "--show-current").trim();
    assert.equal(branch, "task-group-1");
});

test("test_createWorktreeForGroupReusesAnExistingWorktreeAtTheSamePath", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const first = createWorktreeForGroup(repoRoot, group);
    const second = createWorktreeForGroup(repoRoot, group);
    assert.equal(second, first);
});

test("test_createWorktreeForGroupRebasesAStaleWorktreeOntoTheSourceBranchTip", () => {
    // Setup: a worktree left behind by an earlier run, holding that run's commit.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    writeFileSync(join(worktreePath, "stale.txt"), "from the previous run\n");
    git(worktreePath, "add", "stale.txt");
    git(worktreePath, "commit", "-q", "-m", "previous run");
    // Setup: the source branch has since moved on.
    writeFileSync(join(repoRoot, "fresh.txt"), "landed since\n");
    git(repoRoot, "add", "fresh.txt");
    git(repoRoot, "commit", "-q", "-m", "fresh work");
    const sourceTip = git(repoRoot, "rev-parse", "HEAD").trim();
    // Test action: a second run hands a worker the same path.
    createWorktreeForGroup(repoRoot, group);
    // Verification: the worker gets the source branch tip, not the earlier run's codebase.
    assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), sourceTip);
    assert.equal(existsSync(join(worktreePath, "fresh.txt")), true);
    assert.equal(existsSync(join(worktreePath, "stale.txt")), false);
});

test("test_createWorktreeForGroupPopulatesSubmoduleWorkingTrees", () => {
    // Setup: a repo whose `vendor/` submodule holds a file with a known marker.
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    // Test action: create the worktree a worker agent would be handed.
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    // Verification: the submodule directory holds its files instead of being empty.
    assert.equal(existsSync(join(worktreePath, "vendor", "inner.txt")), true);
});

test("test_createWorktreeForGroupThrowsWhenSubmoduleInitFails", () => {
    // Setup: a repo with a submodule whose origin no longer exists on disk.
    const { repoRoot, submoduleOrigin } = makeTempRepoWithLocalSubmodule();
    rmSync(submoduleOrigin, { recursive: true, force: true });
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    // Verification: the run stops rather than handing a worker a half-populated worktree.
    assert.throws(() => createWorktreeForGroup(repoRoot, group));
});

test("test_buildWorkflowArgumentsDictatesThePlanFilePathForEveryTask", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [268, 270], filePaths: ["a.ts"], scope: "declared" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const tasks = workflowArguments.groups[0].tasks;
    assert.match(tasks.find((t) => t.number === 268)!.planFile, /plans\/task-268-plan\.md$/);
    assert.match(tasks.find((t) => t.number === 270)!.planFile, /plans\/task-270-plan\.md$/);
});

test("test_buildWorkflowArgumentsProducesIdenticalOutputForIdenticalInput", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const first = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const second = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("test_generateRunIdProducesDifferentValuesOnEachCall", () => {
    const first = generateRunId();
    const second = generateRunId();
    assert.equal(typeof first, "string");
    assert.ok(first.length > 0);
    assert.notEqual(first, second);
});

test("test_mergeScriptPathPointsAtTheSiblingMergeScriptAsAnAbsolutePath", () => {
    const path = resolveMergeScriptPath();
    assert.equal(isAbsolute(path), true);
    assert.match(path, /mergeTaskWorktrees\.ts$/);
});

test("test_selectRequestedTasksRefusesToRunWhenNoTaskNumbersWereGiven", () => {
    // Setup: two open tasks and an empty requested-numbers list.
    const openTasks = [{ taskNumber: 1 }, { taskNumber: 2 }];
    // Verification: throws instead of falling back to every open task.
    assert.throws(() => selectRequestedTasks(openTasks, []), /no task numbers/i);
});

test("test_selectRequestedTasksRefusesWhenARequestedNumberIsNotOpen", () => {
    // Setup: open tasks 1 and 2, with 9 requested alongside them.
    const openTasks = [{ taskNumber: 1 }, { taskNumber: 2 }];
    // Test action and verification: the missing number is named in the error, rather than dropped.
    assert.throws(() => selectRequestedTasks(openTasks, [1, 9]), /9/);
});

test("test_selectRequestedTasksExcludesTasksBlockedByAnOpenTask", () => {
    // Setup: task 2 is blocked by open task 1; both are requested.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [1], files: ["b.ts"] }];
    // Test action: select both requested tasks.
    const selected = selectRequestedTasks(openTasks, [1, 2]);
    // Verification: only the unblocked task survives, so no worktree is built for blocked work.
    assert.deepEqual(selected.map((t) => t.taskNumber), [1]);
});

test("test_selectRequestedTasksRefusesTasksWithNoFilesArray", () => {
    // Setup: task 1 declares files, task 2 has no files key at all; both are requested.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2 }];
    // Verification: the run stops and names only the undeclared task.
    assert.throws(() => selectRequestedTasks(openTasks, [1, 2]), /\b2\b/);
});

test("test_selectRequestedTasksTreatsAnEmptyFilesArrayAsUndeclared", () => {
    // Setup: task 1 carries an explicitly empty files array.
    const openTasks = [{ taskNumber: 1, files: [] }];
    // Verification: an empty array is refused like a missing one — no ownership fence.
    assert.throws(() => selectRequestedTasks(openTasks, [1]), /files/i);
});

test("test_selectRequestedTasksIgnoresMissingFilesOnABlockedTask", () => {
    // Setup: task 2 is blocked by open task 1 and declares no files; task 1 declares files.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [1] }];
    // Test action: select both requested tasks.
    const selected = selectRequestedTasks(openTasks, [1, 2]);
    // Verification: the blocked task is dropped before the files check, not stopping the run.
    assert.deepEqual(selected.map((t) => t.taskNumber), [1]);
});

test("test_selectRequestedTasksPointsAtTheUpdateTaskFilesSkillThatActuallyExists", () => {
    // Setup: one requested task with no files, and the skill directory on disk.
    const openTasks = [{ taskNumber: 7 }];
    // Test action: capture the refusal message.
    let message = "";
    try { selectRequestedTasks(openTasks, [7]); } catch (error) { message = (error as Error).message; }
    // Verification: message names update-task-files, and its SKILL.md exists, so the pointer can't rot.
    assert.match(message, /update-task-files/);
    assert.ok(existsSync(join(import.meta.dirname, "..", "skills", "update-task-files", "SKILL.md")));
});

test("test_createWorktreeForGroupPutsSubmoduleOnTheGroupBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    const branch = git(join(worktreePath, "vendor"), "branch", "--show-current").trim();
    assert.equal(branch, "task-group-1");
});

test("test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    git(join(repoRoot, "vendor"), "checkout", "--detach", "HEAD");
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    assert.throws(() => buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups));
    assert.equal(existsSync(join(tmpdir(), "taskTools-wt", basename(repoRoot), "group-1")), false);
});

test("test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const paths = workflowArguments.repositorySources.map((source) => source.path);
    assert.ok(paths.includes(""));
    assert.ok(paths.includes("vendor"));
});

```

### tests/runStartup.test.ts

```
// Behavioral checks for runStartup.ts: read-only discovery, and the gate before every mutating step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    confirmTestHookEnabled,
    discoverStartupState,
    runGatedMutatingSteps,
    runStartup,
    type HookCheckResult,
} from "../scripts/runStartup.ts";

const RUN_STARTUP_SOURCE = readFileSync(join(import.meta.dirname, "..", "scripts", "runStartup.ts"), "utf8");
const HOOKS_JSON_PATH = join(import.meta.dirname, "..", "hooks", "hooks.json");

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "taskTools-runStartup-"));
    writeFileSync(
        join(root, "tasks.json"),
        JSON.stringify([
            { taskNumber: 1, title: "open, unblocked" },
            { taskNumber: 2, title: "blocked by open task", blockedBy: [1] },
        ]),
    );
    writeFileSync(join(root, "completedTasks.json"), "[]");
    return root;
}

function makeHooksJson(dir: string, entryOptions: { present: boolean; enabled?: boolean }): string {
    const path = join(dir, "hooks.json");
    const hooks = entryOptions.present
        ? [
              {
                  matcher: "Edit|Write|NotebookEdit",
                  hooks: [
                      {
                          type: "command",
                          command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/relatedTests.ts"',
                          ...(entryOptions.enabled === undefined ? {} : { enabled: entryOptions.enabled }),
                      },
                  ],
              },
          ]
        : [];
    writeFileSync(path, JSON.stringify({ hooks: { PostToolUse: hooks } }));
    return path;
}

test("discovery reports blocked/unblocked open tasks and performs no writes", () => {
    const root = makeProjectRoot();
    const before = readFileSync(join(root, "tasks.json"), "utf8");
    const discovery = discoverStartupState(root);
    assert.deepEqual(discovery.unblockedTaskNumbers, [1]);
    assert.deepEqual(discovery.blockedTaskNumbers, [2]);
    assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
});

test("confirmTestHookEnabled: missing entry point is not enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-hooks-"));
    const path = makeHooksJson(dir, { present: false });
    const result = confirmTestHookEnabled(path);
    assert.equal(result.enabled, false);
    assert.match(result.reason ?? "", /not registered/);
});

test("confirmTestHookEnabled: entry explicitly disabled is not enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-hooks-"));
    const path = makeHooksJson(dir, { present: true, enabled: false });
    const result = confirmTestHookEnabled(path);
    assert.equal(result.enabled, false);
    assert.match(result.reason ?? "", /disabled/);
});

test("confirmTestHookEnabled: registered entry with no enabled flag defaults to enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "taskTools-hooks-"));
    const path = makeHooksJson(dir, { present: true });
    assert.equal(confirmTestHookEnabled(path).enabled, true);
});

type HookEntryFixture = { hooks?: { command?: string }[] };

test("hooks/hooks.json registers the copied relatedTests.ts entry point", () => {
    const parsed: { hooks: Record<string, HookEntryFixture[]> } = JSON.parse(readFileSync(HOOKS_JSON_PATH, "utf8"));
    const commands = Object.values(parsed.hooks)
        .flat()
        .flatMap((entry) => entry.hooks ?? [])
        .map((hook) => hook.command ?? "");
    assert.ok(
        commands.some((command) => command.includes("scripts/relatedTests.ts")),
        "expected an entry invoking scripts/relatedTests.ts",
    );
    assert.equal(confirmTestHookEnabled(HOOKS_JSON_PATH).enabled, true);
});

test("hook disabled: runStartup stops before any mutating step runs", () => {
    const worktreeCalls: string[] = [];
    const branchCalls: string[] = [];
    const result = runStartup({
        cwd: makeProjectRoot(),
        confirmHook: (): HookCheckResult => ({ enabled: false, reason: "test hook disabled" }),
        mutatingSteps: [() => worktreeCalls.push("worktree"), () => branchCalls.push("branch")],
    });
    assert.equal(result.stopped, true);
    assert.match(result.reason ?? "", /disabled/);
    assert.deepEqual(worktreeCalls, []);
    assert.deepEqual(branchCalls, []);
    assert.equal(result.stepsRun, 0);
});

test("gate precedes every mutating step individually, not just the first", () => {
    const callOrder: string[] = [];
    let hookCallCount = 0;
    const confirmHook = (): HookCheckResult => {
        hookCallCount++;
        callOrder.push(`gate-${hookCallCount}`);
        return { enabled: true };
    };
    const steps = [
        () => callOrder.push("step-1"),
        () => callOrder.push("step-2"),
        () => callOrder.push("step-3"),
    ];
    const result = runGatedMutatingSteps(steps, confirmHook);
    assert.equal(result.stopped, false);
    assert.equal(result.stepsRun, 3);
    assert.deepEqual(callOrder, ["gate-1", "step-1", "gate-2", "step-2", "gate-3", "step-3"]);
});

test("gate stopping mid-sequence prevents later steps from running", () => {
    const callOrder: string[] = [];
    let gateCallCount = 0;
    const confirmHook = (): HookCheckResult => {
        gateCallCount++;
        return { enabled: gateCallCount < 2 };
    };
    const steps = [() => callOrder.push("step-1"), () => callOrder.push("step-2"), () => callOrder.push("step-3")];
    const result = runGatedMutatingSteps(steps, confirmHook);
    assert.equal(result.stopped, true);
    assert.equal(result.stepsRun, 1);
    assert.deepEqual(callOrder, ["step-1"]);
});

test("runStartup's read-only discovery phase never calls the gate or a mutating step", () => {
    let confirmHookCalls = 0;
    const stepCalls: string[] = [];
    runStartup({
        cwd: makeProjectRoot(),
        confirmHook: () => {
            confirmHookCalls++;
            return { enabled: true };
        },
        mutatingSteps: [],
    });
    assert.equal(stepCalls.length, 0);
    assert.equal(confirmHookCalls, 0, "no mutating steps means the gate should never run");
});

test("runStartup.ts never references semantic-commit/push/merge/base-update/archival helpers", () => {
    const forbidden = [
        "archiveProcessed",
        "baseReconciliation",
        "repositoryIntegration",
        "mergeTaskWorktrees",
        "createBranchInEveryRepository",
    ];
    for (const name of forbidden) {
        assert.ok(!RUN_STARTUP_SOURCE.includes(name), `runStartup.ts must not reference ${name}`);
    }
});

```

### tests/taskStats.test.ts

```
// Behavioral checks for taskStats.ts. Run with: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTaskStats, formatTaskStats } from "../scripts/taskStats.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "taskStats.ts");
const TODAY = "2026-07-31";

function openTask(taskNumber: number, extra: Record<string, unknown> = {}) {
    return { taskNumber, title: `task ${taskNumber}`, ...extra };
}

function closedTask(taskNumber: number, completionDate: string, extra: Record<string, unknown> = {}) {
    return { taskNumber, title: `task ${taskNumber}`, completionDate, ...extra };
}

test("counts open and completed tasks separately", () => {
    const stats = computeTaskStats([openTask(1), openTask(2)], [closedTask(3, "2026-07-30")], TODAY);
    assert.equal(stats.openCount, 2);
    assert.equal(stats.completedCount, 1);
});

test("a task is blocked only by blockers that are still open", () => {
    const open = [openTask(1, { blockedBy: [2] }), openTask(2), openTask(3, { blockedBy: [99] })];
    const stats = computeTaskStats(open, [], TODAY);
    assert.equal(stats.blockedCount, 1);
    assert.equal(stats.unblockedCount, 2);
});

test("reports how many open tasks declare files", () => {
    const open = [openTask(1, { files: ["a.ts"] }), openTask(2), openTask(3, { files: [] })];
    const stats = computeTaskStats(open, [], TODAY);
    assert.equal(stats.openWithFiles, 1);
    assert.equal(stats.openWithoutFiles, 2);
});

test("closure windows count completionDate within 7 and 30 days of today", () => {
    const completed = [
        closedTask(1, "2026-07-31"),
        closedTask(2, "2026-07-25"),
        closedTask(3, "2026-07-10"),
        closedTask(4, "2026-05-01"),
    ];
    const stats = computeTaskStats([], completed, TODAY);
    assert.equal(stats.closedLast7, 2);
    assert.equal(stats.closedLast30, 3);
    assert.equal(stats.completedCount, 4);
});

test("busiest day is the completionDate closing the most tasks", () => {
    const completed = [
        closedTask(1, "2026-07-30"),
        closedTask(2, "2026-07-30"),
        closedTask(3, "2026-07-29"),
    ];
    const stats = computeTaskStats([], completed, TODAY);
    assert.deepEqual(stats.busiestDay, { date: "2026-07-30", count: 2 });
});

test("busiestDay is null when nothing has been closed", () => {
    assert.equal(computeTaskStats([], [], TODAY).busiestDay, null);
});

test("counts completed tasks that recorded commit hashes", () => {
    const completed = [
        closedTask(1, "2026-07-30", { commitHashes: ["abc1234"] }),
        closedTask(2, "2026-07-30", { commitHashes: [] }),
        closedTask(3, "2026-07-30"),
    ];
    assert.equal(computeTaskStats([], completed, TODAY).completedWithCommitHashes, 1);
});

test("group forecast joins tasks sharing a file and separates disjoint ones", () => {
    const open = [
        openTask(1, { files: ["shared.ts"] }),
        openTask(2, { files: ["shared.ts", "b.ts"] }),
        openTask(3, { files: ["c.ts"] }),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.equal(stats.groupCount, 2);
    assert.equal(stats.largestGroupSize, 2);
});

test("group forecast excludes blocked tasks and tasks declaring no files", () => {
    const open = [
        openTask(1, { files: ["a.ts"] }),
        openTask(2, { files: ["b.ts"], blockedBy: [1] }),
        openTask(3),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.equal(stats.groupCount, 1);
    assert.equal(stats.forecastTaskCount, 1);
});

test("contended files rank paths claimed by more than one open task", () => {
    const open = [
        openTask(1, { files: ["hot.ts", "cold.ts"] }),
        openTask(2, { files: ["hot.ts"] }),
        openTask(3, { files: ["hot.ts"] }),
    ];
    const stats = computeTaskStats(open, [], TODAY);
    assert.deepEqual(stats.contendedFiles[0], { path: "hot.ts", taskCount: 3 });
    assert.equal(stats.contendedFiles.some(f => f.path === "cold.ts"), false);
});

test("formatted output names every headline number", () => {
    const text = formatTaskStats(computeTaskStats([openTask(1, { files: ["a.ts"] })], [closedTask(2, "2026-07-30")], TODAY));
    for (const fragment of ["open", "completed", "closed", "groups", "files"]) {
        assert.match(text, new RegExp(fragment));
    }
});

test("CLI prints stats for the project it is run from", () => {
    const root = mkdtempSync(join(tmpdir(), "taskTools-taskStats-"));
    writeFileSync(join(root, "tasks.json"), JSON.stringify([openTask(1, { files: ["a.ts"] }), openTask(2)]));
    writeFileSync(join(root, "completedTasks.json"), JSON.stringify([closedTask(3, "2026-07-30")]));
    const output = execFileSync("node", [SCRIPT], { cwd: root, encoding: "utf8" });
    assert.match(output, /2 open/);
    assert.match(output, /1 completed/);
});

test("CLI reports empty projects without crashing", () => {
    const root = mkdtempSync(join(tmpdir(), "taskTools-taskStats-empty-"));
    writeFileSync(join(root, "tasks.json"), "[]");
    writeFileSync(join(root, "completedTasks.json"), "[]");
    const output = execFileSync("node", [SCRIPT], { cwd: root, encoding: "utf8" });
    assert.match(output, /0 open/);
});

```

### tests/getTaskDetails.test.ts

```
// getTaskDetails.ts: no-arg listing marks blocked tasks with [blockedBy: ...] for pick-a-task/tackle-tasks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "getTaskDetails.ts");

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-details-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "unblocked task" },
      { taskNumber: 2, title: "blocked task", blockedBy: [1, 3] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 3, title: "done task" }]));
  return root;
}

test("listing marks blocked tasks and leaves unblocked ones plain", () => {
  const out = runScript(makeProjectRoot());
  assert.match(out, /OPEN 1: unblocked task\n/);
  assert.match(out, /OPEN 2: blocked task \[blockedBy: 1,3\]/);
  assert.doesNotMatch(out, /unblocked task \[blockedBy/);
  assert.match(out, /DONE 3: done task\n/);
});

test("digits inside trailing prose are not treated as task numbers", () => {
  const out = runScript(
    makeProjectRoot(),
    "1 closureNote: Verified NO (2026-07-21) — see task 2, stall 2252s (task 3, still open).",
  );
  assert.match(out, /task 1 \(OPEN\)/);
  assert.doesNotMatch(out, /task (2|3|2026|2252)[ :(]/);
});

test("a JSON array first argument closes the batch the skill named", () => {
  // close-tasks passes details via '$1', the no-space JSON array token that survives quoted closureNotes.
  const root = makeProjectRoot();
  for (const arg of ["[1,2]", '"[1,2]"', "1,2"]) {
    const out = runScript(root, arg);
    assert.match(out, /task 1 \(OPEN\)/, `${arg} should resolve task 1`);
    assert.match(out, /task 2 \(OPEN\)/, `${arg} should resolve task 2`);
  }
});

test("full details include the blockedBy field", () => {
  const out = runScript(makeProjectRoot(), "2");
  assert.match(out, /task 2 \(OPEN\)/);
  assert.deepEqual(JSON.parse(out.slice(out.indexOf("{"))).blockedBy, [1, 3]);
});

test("findTask resolves open first, falls back to completed, and importing runs no CLI", async () => {
  const root = makeProjectRoot();
  const { findTask } = await import("../scripts/getTaskDetails.ts");
  assert.equal(findTask(1, root)?.title, "unblocked task");
  assert.equal(findTask(3, root)?.title, "done task");
  assert.equal(findTask(99, root), undefined);
});

```

### tests/unblockDependents.test.ts

```
// Behavioral checks for unblockDependents.ts: closed task numbers are removed
// from every tasks.json entry's blockedBy array, and the field is dropped
// entirely when it empties. Untouched entries stay byte-identical.
// Run with: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "unblockDependents.ts");

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-unblock-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 2, title: "fully blocked", blockedBy: [1] },
      { taskNumber: 4, title: "partly blocked", blockedBy: [1, 3] },
      { taskNumber: 5, title: "unrelated" },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("removes closed number, drops emptied blockedBy, keeps other blockers", () => {
  const root = makeProjectRoot();
  const out = runScript(root, "1");
  const tasks = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 2), false);
  assert.deepEqual(tasks.find((t: any) => t.taskNumber === 4).blockedBy, [3]);
  assert.equal("blockedBy" in tasks.find((t: any) => t.taskNumber === 5), false);
  assert.match(out, /task\(s\): 2, 4/);
});

test("no matching blockers leaves tasks.json untouched", () => {
  const root = makeProjectRoot();
  const before = readFileSync(join(root, "tasks.json"), "utf8");
  const out = runScript(root, "99");
  assert.equal(readFileSync(join(root, "tasks.json"), "utf8"), before);
  assert.match(out, /no blockedBy references/);
});

```

### tests/mergeTaskWorktrees.test.ts

```
// Behavioral checks for mergeTaskWorktrees.ts: merges, conflict abort, gitlink resolution, submodule merges. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWorktreeForGroup, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "../scripts/prepareTasks.ts";
import type { PreparedGroup, WorkflowArguments } from "../scripts/prepareTasks.ts";
import { currentBranchName } from "../scripts/repositoryBranches.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { bootstrapRepositoryManifest } from "../scripts/manifestBootstrap.ts";
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "mergeTaskWorktrees.ts");

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "merge-worktrees-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function makeGroup(repoRoot: string, groupId: number): PreparedGroup {
    const worktree = createWorktreeForGroup(repoRoot, { groupId, taskNumbers: [groupId], filePaths: [], scope: "unknown" });
    return { groupId, worktree, branch: `task-group-${groupId}`, scope: "unknown", tasks: [] };
}

type SubmoduleManifestSpec = { checkoutPath: string; baseBranch: string; baseOid: string; operationBranch: string };

function makeManifest(
    baseBranch: string,
    baseOid: string,
    operationBranch: string,
    submodules: SubmoduleManifestSpec[] = [],
): RepositoryManifest {
    const root = {
        occurrenceId: "root",
        checkoutPath: "",
        parentOccurrenceId: null,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: "",
        baseBranch,
        baseOid,
        operationBranch,
        childOccurrenceIds: submodules.map((_, index) => `sub-${index}`),
        testState: "untested" as const,
    };
    const subOccurrences = submodules.map((sub, index) => ({
        occurrenceId: `sub-${index}`,
        checkoutPath: sub.checkoutPath,
        parentOccurrenceId: "root",
        pathInParent: sub.checkoutPath,
        gitlinkOid: null,
        depth: 1,
        originUrl: "",
        baseBranch: sub.baseBranch,
        baseOid: sub.baseOid,
        operationBranch: sub.operationBranch,
        childOccurrenceIds: [],
        testState: "untested" as const,
    }));
    return { version: REPOSITORY_MANIFEST_VERSION, occurrences: [root, ...subOccurrences] };
}

function makeTempRepoWithLocalSubmodule(): string {
    const submoduleOrigin = makeTempRepoWithCommit();
    // git >=2.38 blocks file-transport submodules; repo config is ignored here, env is not.
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const repoRoot = makeTempRepoWithCommit();
    git(repoRoot, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(repoRoot, "commit", "-q", "-m", "add submodule");
    return repoRoot;
}

test("test_removeWorktreeAndBranchDeletesAWorktreeThatContainsSubmodules", () => {
    // Setup: a worktree whose submodule was populated by createWorktreeForGroup.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const group = makeGroup(repoRoot, 1);
    assert.equal(existsSync(join(group.worktree, "vendor", "seed.txt")), true);
    // Test action and verification: cleanup removes the worktree instead of refusing.
    removeWorktreeAndBranch(repoRoot, group.worktree, group.branch);
    assert.equal(existsSync(group.worktree), false);
});

test("test_mergeGroupBranchIntoRepoReportsSuccessForANonConflictingBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, true);
    assert.deepEqual(outcome.conflictedFilePaths, []);
    assert.equal(existsSync(join(repoRoot, "new.txt")), true);
});

test("test_mergeGroupBranchIntoRepoReportsConflictedPathsAndAbortsTheMerge", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, false);
    assert.deepEqual(outcome.conflictedFilePaths, ["shared.txt"]);
    const status = git(repoRoot, "status", "--porcelain=v1", "-z").trim();
    assert.equal(status.includes("MERGE_MSG"), false);
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
});

test("test_mergeGroupBranchIntoRepoLeavesTheWorktreeInPlaceAfterAConflict", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(existsSync(group.worktree), true);
});

test("test_removeWorktreeAndBranchDeletesBothAfterACleanMerge", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    git(repoRoot, "merge", "--no-ff", group.branch, "-q", "-m", "merge");

    removeWorktreeAndBranch(repoRoot, group.worktree, group.branch);
    assert.equal(existsSync(group.worktree), false);
    const branches = git(repoRoot, "branch", "--list");
    assert.equal(branches.includes(group.branch), false);
});

test("test_mergeGroupBranchIntoRepoContinuesToLaterGroupsAfterAnEarlierConflict", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group1 = makeGroup(repoRoot, 1);
    writeFileSync(join(group1.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group1.worktree, "add", "shared.txt");
    git(group1.worktree, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    const group2 = makeGroup(repoRoot, 2);
    writeFileSync(join(group2.worktree, "group2.txt"), "clean add\n");
    git(group2.worktree, "add", "group2.txt");
    git(group2.worktree, "commit", "-q", "-m", "add group2.txt");

    const outcome1 = mergeGroupBranchIntoRepo(repoRoot, group1, sourceBranch, []);
    const outcome2 = mergeGroupBranchIntoRepo(repoRoot, group2, sourceBranch, []);
    assert.equal(outcome1.merged, false);
    assert.equal(outcome2.merged, true);
});

test("test_mergeGroupBranchIntoRepoChecksOutTheSourceBranchBeforeMerging", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    git(repoRoot, "checkout", "-b", "some-other-branch");

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, true);
    assert.equal(currentBranchName(repoRoot), sourceBranch);
    assert.equal(existsSync(join(repoRoot, "new.txt")), true);
});

test("test_mergeSubmoduleBranchSurvivesEvenWhenTheGroupConflicts", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const sourceBranch = currentBranchName(mainSubmodulePath);
    const group = makeGroup(repoRoot, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const groupBranch = currentBranchName(worktreeSubmodulePath);

    writeFileSync(join(worktreeSubmodulePath, "seed.txt"), "from-worktree\n");
    git(worktreeSubmodulePath, "add", "seed.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(mainSubmodulePath, "seed.txt"), "from-main\n");
    git(mainSubmodulePath, "add", "seed.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "main edit");

    const outcome = mergeSubmoduleBranchIntoRepo(mainSubmodulePath, worktreeSubmodulePath, sourceBranch);
    assert.equal(outcome.merged, false);
    const branches = git(mainSubmodulePath, "branch", "--list", groupBranch);
    assert.ok(branches.includes(groupBranch));
});

test("test_runAsCliLeavesTheWorktreeAndBranchInPlaceAfterASuccessfulMerge", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const preparedGroup: PreparedGroup = group;
    const workflowArguments: WorkflowArguments = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [preparedGroup],
        repositorySources: [{ path: "", sourceBranch }],
    };
    const preMergeBaseOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const cliInput = { ...workflowArguments, repositoryManifest: makeManifest(sourceBranch, preMergeBaseOid, group.branch) };
    execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });

    assert.equal(existsSync(group.worktree), true);
    const branches = git(repoRoot, "branch", "--list", group.branch);
    assert.ok(branches.includes(group.branch));
});

test("test_mergeGroupBranchIntoRepoReportsWhyAMergeThatNeverStartedFailed", () => {
    // Setup: an uncommitted local edit that git refuses to overwrite, so the merge never starts.
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    writeFileSync(join(repoRoot, "new.txt"), "untracked squatter\n");

    // Test action and verification: it reports instead of crashing on an empty commit.
    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, false);
    assert.deepEqual(outcome.conflictedFilePaths, []);
    assert.ok(outcome.failureReason && outcome.failureReason.length > 0);
});

test("test_resolveGitlinkConflictsAutoResolvesASubmodulePointerConflict", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const baseBranch = currentBranchName(repoRoot);
    const submoduleBaseBranch = currentBranchName(mainSubmodulePath);

    git(mainSubmodulePath, "checkout", "-b", "branch-a");
    writeFileSync(join(mainSubmodulePath, "a.txt"), "a\n");
    git(mainSubmodulePath, "add", "a.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "a");
    const commitA = git(mainSubmodulePath, "rev-parse", "HEAD").trim();

    git(mainSubmodulePath, "checkout", submoduleBaseBranch);
    git(mainSubmodulePath, "checkout", "-b", "branch-b");
    writeFileSync(join(mainSubmodulePath, "b.txt"), "b\n");
    git(mainSubmodulePath, "add", "b.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "b");
    const commitB = git(mainSubmodulePath, "rev-parse", "HEAD").trim();

    git(mainSubmodulePath, "checkout", commitA);
    git(repoRoot, "checkout", "-b", "feature");
    git(repoRoot, "add", "vendor");
    git(repoRoot, "commit", "-q", "-m", "feature submodule pointer");

    git(repoRoot, "checkout", baseBranch);
    git(mainSubmodulePath, "checkout", commitB);
    git(repoRoot, "add", "vendor");
    git(repoRoot, "commit", "-q", "-m", "base submodule pointer");

    let threw = false;
    try {
        git(repoRoot, "merge", "--no-ff", "feature", "-m", "merge feature");
    } catch {
        threw = true;
    }
    assert.equal(threw, true);

    // Intended resolution: keep feature's submodule commit.
    git(mainSubmodulePath, "checkout", commitA);

    const resolution = resolveGitlinkConflicts(repoRoot, ["vendor"]);
    assert.equal(resolution.resolved, true);
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
});

test("test_resolveGitlinkConflictsAbortsOnANonSubmoduleConflict", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    let threw = false;
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", "merge");
    } catch {
        threw = true;
    }
    assert.equal(threw, true);

    const resolution = resolveGitlinkConflicts(repoRoot, []);
    assert.equal(resolution.resolved, false);
    assert.ok(resolution.unexpectedConflicts.includes("shared.txt"));
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
});

test("test_runPipelineCliMintsApprovalAndPublicationTargetsWhenEvidenceIsCompleteAndGreen", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const sourceBranch = currentBranchName(repoRoot);
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    const group = makeGroup(repoRoot, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const submoduleGroupBranch = currentBranchName(worktreeSubmodulePath);

    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    writeFileSync(join(worktreeSubmodulePath, "vendor-new.txt"), "vendor new\n");
    git(worktreeSubmodulePath, "add", "vendor-new.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "add vendor-new.txt");

    const preMergeRootOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const preMergeSubmoduleOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();
    const testReceipts = [{ groupId: "1", status: "green" }];
    const reviewHandoffs = ["reviewed by codex"];
    const cliInput = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [
            { path: "", sourceBranch },
            { path: "vendor", sourceBranch: submoduleSourceBranch },
        ],
        repositoryManifest: makeManifest(sourceBranch, preMergeRootOid, group.branch, [
            { checkoutPath: "vendor", baseBranch: submoduleSourceBranch, baseOid: preMergeSubmoduleOid, operationBranch: submoduleGroupBranch },
        ]),
        testReceipts,
        reviewHandoffs,
    };
    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });
    const output = JSON.parse(stdout);
    const postMergeRootOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const postMergeSubmoduleOid = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();

    assert.equal(output.runState.readyForApproval, true);
    assert.ok(output.runState.approval && output.runState.approval.digest.length > 0);
    assert.ok(output.runState.authorization);
    assert.deepEqual(output.runState.digestInput.testReceipts, testReceipts);
    assert.deepEqual(output.runState.digestInput.reviewHandoffs, reviewHandoffs);
    assert.deepEqual(output.publicationTargets, [
        { repositoryPath: "", recordedBaseOid: preMergeRootOid, targetOid: postMergeRootOid },
        { repositoryPath: "vendor", recordedBaseOid: preMergeSubmoduleOid, targetOid: postMergeSubmoduleOid },
    ]);
    assert.notEqual(preMergeRootOid, postMergeRootOid);
    assert.notEqual(preMergeSubmoduleOid, postMergeSubmoduleOid);
});

test("test_runFlagReadsPreparedArgumentsAndOutcomesFromDiskThenDeletesThem", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const preMergeBaseOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const argumentsFile = resolveRunArgumentsPath(repoRoot);
    const outcomesFile = resolveRunOutcomesPath(repoRoot);
    mkdirSync(dirname(argumentsFile), { recursive: true });
    writeFileSync(argumentsFile, JSON.stringify({
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [{ path: "", sourceBranch }],
        repositoryManifest: makeManifest(sourceBranch, preMergeBaseOid, group.branch),
    }));
    writeFileSync(outcomesFile, JSON.stringify({
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    }));

    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, "--run", argumentsFile, outcomesFile], { encoding: "utf8" });
    const output = JSON.parse(stdout);

    assert.equal(output.merged.length, 1);
    assert.equal(output.runState.readyForApproval, true);
    assert.deepEqual(output.reviewHandoffs, ["reviewed by codex"]);
    assert.equal(existsSync(argumentsFile), false);
    assert.equal(existsSync(outcomesFile), false);
});

test("test_runPipelineCliProducesNoApprovalStateWhenAGroupConflicts", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    const preMergeBaseOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const cliInput = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [{ path: "", sourceBranch }],
        repositoryManifest: makeManifest(sourceBranch, preMergeBaseOid, group.branch),
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    };
    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });
    const output = JSON.parse(stdout);

    assert.equal(output.conflicts.length, 1);
    assert.equal(output.runState.readyForApproval, false);
    assert.equal(output.runState.approval, undefined);
    assert.equal(output.runState.authorization, undefined);
    assert.deepEqual(output.publicationTargets, []);
});

test("test_noEvidenceCausesNoFinalizationMutation", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const preMergeBaseOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const cliInput = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [{ path: "", sourceBranch }],
        repositoryManifest: makeManifest(sourceBranch, preMergeBaseOid, group.branch),
    };
    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });
    const output = JSON.parse(stdout);

    assert.equal(output.runState.readyForApproval, false);
    assert.equal(output.runState.approval, undefined);
    assert.equal(output.runState.authorization, undefined);
    assert.deepEqual(output.publicationTargets, []);
    assert.equal(git(repoRoot, "rev-parse", sourceBranch).trim(), preMergeBaseOid);
    const refs = git(repoRoot, "for-each-ref", "--format=%(refname)").split("\n");
    assert.equal(refs.some((ref) => ref.startsWith("refs/finalize/")), false);
    assert.equal(refs.some((ref) => ref.startsWith("refs/heads/operations/")), false);
    assert.deepEqual(refs.filter((ref) => ref.startsWith("refs/heads/") && ref !== `refs/heads/${sourceBranch}` && ref !== `refs/heads/${group.branch}`), []);
});

test("test_productionShapedNestedFinalizationSucceeds", () => {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const rootPath = makeTempRepoWithCommit();
    const submoduleSourcePath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", submoduleSourcePath, "vendor");
    git(rootPath, "commit", "-q", "-m", "add submodule");

    const bootstrapResult = bootstrapRepositoryManifest(rootPath);
    assert.equal(bootstrapResult.refused, false);
    const occurrenceGraph = bootstrapResult.refused ? [] : bootstrapResult.occurrenceGraph;
    const manifest: RepositoryManifest = { version: REPOSITORY_MANIFEST_VERSION, occurrences: occurrenceGraph };
    const rootOccurrence = occurrenceGraph.find((o) => o.parentOccurrenceId === null)!;
    assert.equal(rootOccurrence.operationBranch, "");
    assert.ok(rootOccurrence.checkoutPath.startsWith("/"));

    const sourceBranch = currentBranchName(rootPath);
    const submodulePath = join(rootPath, "vendor");
    const submoduleSourceBranch = currentBranchName(submodulePath);
    const group = makeGroup(rootPath, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    writeFileSync(join(worktreeSubmodulePath, "vendor-new.txt"), "vendor new\n");
    git(worktreeSubmodulePath, "add", "vendor-new.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "add vendor-new.txt");

    const preMergeRootOid = git(rootPath, "rev-parse", sourceBranch).trim();
    const preMergeSubmoduleOid = git(submodulePath, "rev-parse", submoduleSourceBranch).trim();

    const cliInput = {
        repo: rootPath,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [
            { path: "", sourceBranch },
            { path: "vendor", sourceBranch: submoduleSourceBranch },
        ],
        repositoryManifest: manifest,
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    };
    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });
    const output = JSON.parse(stdout);

    assert.deepEqual(
        Object.keys(output).sort(),
        ["merged", "conflicts", "testReceipts", "reviewHandoffs", "occurrenceDigests", "runState", "publicationTargets"].sort(),
    );
    assert.equal(output.runState.readyForApproval, true);

    const postMergeRootOid = git(rootPath, "rev-parse", sourceBranch).trim();
    const postMergeSubmoduleOid = git(submodulePath, "rev-parse", submoduleSourceBranch).trim();
    const rootTarget = output.publicationTargets.find((t: { repositoryPath: string }) => t.repositoryPath === "");
    const subTarget = output.publicationTargets.find((t: { repositoryPath: string }) => t.repositoryPath === "vendor");
    assert.equal(rootTarget.targetOid, postMergeRootOid);
    assert.equal(subTarget.targetOid, postMergeSubmoduleOid);

    assert.doesNotThrow(() => git(rootPath, "merge-base", "--is-ancestor", preMergeRootOid, postMergeRootOid));
    assert.doesNotThrow(() => git(submodulePath, "merge-base", "--is-ancestor", preMergeSubmoduleOid, postMergeSubmoduleOid));

    const rootGitlinkOid = git(rootPath, "ls-tree", sourceBranch, "vendor").trim().split(/\s+/)[2];
    assert.equal(rootGitlinkOid, postMergeSubmoduleOid);

    const refs = git(rootPath, "for-each-ref", "--format=%(refname)").split("\n");
    assert.ok(refs.some((ref) => ref.startsWith("refs/finalize/")));

    assert.equal(existsSync(group.worktree), true);
    const branches = git(rootPath, "branch", "--list", group.branch);
    assert.ok(branches.includes(group.branch));
});

// Root + submodule fixture carrying a real task number, a seeded task file, and the three run-input files.
function buildNestedFixtureWithTask(taskNumber: number) {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const rootPath = makeTempRepoWithCommit();
    const submoduleSourcePath = makeTempRepoWithCommit();
    git(rootPath, "submodule", "add", "-q", submoduleSourcePath, "vendor");
    git(rootPath, "commit", "-q", "-m", "add submodule");

    const bootstrapResult = bootstrapRepositoryManifest(rootPath);
    assert.equal(bootstrapResult.refused, false);
    const manifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: bootstrapResult.refused ? [] : bootstrapResult.occurrenceGraph,
    };

    const sourceBranch = currentBranchName(rootPath);
    const submoduleSourceBranch = currentBranchName(join(rootPath, "vendor"));
    const group = makeGroup(rootPath, 1);
    group.tasks = [{ number: taskNumber, briefFile: "", planFile: "", files: [] }];
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    writeFileSync(join(group.worktree, "vendor", "vendor-new.txt"), "vendor new\n");
    git(join(group.worktree, "vendor"), "add", "vendor-new.txt");
    git(join(group.worktree, "vendor"), "commit", "-q", "-m", "add vendor-new.txt");

    const taskToolsDir = join(rootPath, ".taskTools");
    mkdirSync(taskToolsDir, { recursive: true });
    writeFileSync(
        join(taskToolsDir, "tasks.json"),
        JSON.stringify([{ taskNumber, title: "t", description: "d", files: [], difficulty: 1, blockedBy: [] }]) + "\n",
    );
    writeFileSync(join(taskToolsDir, "completedTasks.json"), "[]\n");
    const runFiles = [resolveRunArgumentsPath(rootPath), resolveRunOutcomesPath(rootPath), resolveStepOutputsPath(rootPath)];
    for (const path of runFiles) writeFileSync(path, "{}\n");

    const cliInput = {
        repo: rootPath,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [
            { path: "", sourceBranch },
            { path: "vendor", sourceBranch: submoduleSourceBranch },
        ],
        repositoryManifest: manifest,
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    };
    return { rootPath, cliInput, runFiles, taskToolsDir };
}

function runPipelineCli(cliInput: unknown): { publicationTargets: unknown[] } {
    return JSON.parse(execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" }));
}

function readTaskNumbers(taskToolsDir: string, fileName: string): number[] {
    return JSON.parse(readFileSync(join(taskToolsDir, fileName), "utf8")).map((task: { taskNumber: number }) => task.taskNumber);
}

test("test_publicationFailureLeavesTaskOpenAndKeepsRunFilesWhileSuccessArchives", () => {
    // Another writer moves the base ref after the manifest is captured, so publication must refuse.
    const raced = buildNestedFixtureWithTask(9101);
    writeFileSync(join(raced.rootPath, "raced.txt"), "another writer\n");
    git(raced.rootPath, "add", "raced.txt");
    git(raced.rootPath, "commit", "-q", "-m", "someone else moved the base");

    assert.deepEqual(runPipelineCli(raced.cliInput).publicationTargets, []);
    assert.deepEqual(readTaskNumbers(raced.taskToolsDir, "tasks.json"), [9101]);
    assert.deepEqual(readTaskNumbers(raced.taskToolsDir, "completedTasks.json"), []);
    for (const path of raced.runFiles) assert.equal(existsSync(path), true);

    // Nothing races the base ref, so the task is archived and the run inputs are cleaned up.
    const clean = buildNestedFixtureWithTask(9102);
    assert.notDeepEqual(runPipelineCli(clean.cliInput).publicationTargets, []);
    assert.deepEqual(readTaskNumbers(clean.taskToolsDir, "tasks.json"), []);
    assert.deepEqual(readTaskNumbers(clean.taskToolsDir, "completedTasks.json"), [9102]);
    for (const path of clean.runFiles) assert.equal(existsSync(path), false);
});

```
