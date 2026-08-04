# Task 37: new skill: /tackle-unblocked-tasks

Works by finding all tasks with empty blockedBy[] arrays, returning an array of task numbers as `unblockedTaskNumbers` sorted lowest to highest, then executes the same code path that invoking 'tackle-tasks unblockedTaskNumbers valid' uses.  

Add an exported `unblockedTaskNumbers(openTasks)` helper to scripts/taskFiles.ts returning ascending-sorted task numbers with empty blockedBy[] arrays. 

### scripts/taskFiles.ts

```
// Resolves a project's tasks.json / completedTasks.json pair: .taskTools/ when present,
// project root otherwise (pre-plugin repos keep their root files); neither present -> the
// .taskTools/ pair, which seedTaskFilesIfAbsent creates on first task creation.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type TaskRecord = { taskNumber: number; title?: string; description?: string } & Record<string, unknown>;
export type TaskFilePair = { tasksPath: string; completedTasksPath: string };

function pairIn(folder: string): TaskFilePair {
  return { tasksPath: join(folder, "tasks.json"), completedTasksPath: join(folder, "completedTasks.json") };
}

// Walks up from `root` so a shell cwd left in a subdirectory still finds the
// project's task files (mid-session `cd`s were silently breaking every skill).
export function resolveTaskFiles(root: string): TaskFilePair {
  for (let dir = root; ; dir = dirname(dir)) {
    const housed = pairIn(join(dir, ".taskTools"));
    if (existsSync(housed.tasksPath)) return housed;
    const atRoot = pairIn(dir);
    if (existsSync(atRoot.tasksPath)) return atRoot;
    if (dirname(dir) === dir) return pairIn(join(root, ".taskTools"));
  }
}

export function seedTaskFilesIfAbsent(pair: TaskFilePair): void {
  for (const path of [pair.tasksPath, pair.completedTasksPath]) {
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "[]\n");
  }
}

// Task numbers lead a skill invocation; free text (closureNote, flags) may follow.
// Stop at the first non-numeric token so digits inside prose — dates, "task 162",
// durations — aren't mistaken for task numbers.
// Brackets and stray quotes are tolerated so a single no-space JSON array token —
// [268,270,281], the shell-safe form skills pass as "$1" — parses like bare numbers.
export function leadingTaskNumbers(args: string[]): number[] {
  const tokens = args.join(" ").trim().split(/\s+/);
  const numeric: number[] = [];
  for (const token of tokens) {
    if (!/^["'[\]\d,]+$/.test(token)) break;
    numeric.push(...(token.match(/\d+/g) ?? []).map(Number));
  }
  return numeric;
}

export function readTaskFile(path: string): TaskRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

```

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

export function mergeScriptPath(): string {
    return join(import.meta.dirname, "mergeTaskWorktrees.ts");
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

function runAsCli(): void {
    const repoRoot = process.cwd();
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const requestedNumbers = leadingTaskNumbers(process.argv.slice(2));
    let tasks: TaskRecord[];
    try {
        tasks = selectRequestedTasks(openTasks, requestedNumbers);
    } catch (error) {
        process.stderr.write(`prepareTasks: ${(error as Error).message}\n`);
        process.exit(1);
    }
    for (const task of tasks) writeTaskBriefFile(task, repoRoot);
    const groups = groupTasksByFileOverlap(tasks);
    const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, groups);
    // startTimestamp is stamped here because workflow scripts cannot call Date.now().
    process.stdout.write(JSON.stringify({
        ...workflowArguments,
        runId: generateRunId(),
        startTimestamp: new Date().toISOString(),
        mergeScript: mergeScriptPath(),
    }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();

```

---

# Current state (read this before planning)

You may only read this brief. Here is what exists on the current branch:

- `scripts/checkBlockers.ts` already parses the flag: `const unblockedOnly = process.argv.includes("--unblocked")` and strips it before `leadingTaskNumbers(...)`.
- `scripts/prepareTasks.ts` does NOT: `runAsCli()` calls `leadingTaskNumbers(process.argv.slice(2))` and throws "no task numbers given; pass a JSON array with no spaces" when the array is missing. Invoking the skill with `--unblocked valid` fails there today — that is the concrete bug to fix.
- `scripts/taskFiles.ts` holds the shared task-reading helpers and is where the exported `unblockedTaskNumbers(openTasks)` helper belongs: ascending-sorted task numbers whose `blockedBy` array is empty or absent.

Scope: export `unblockedTaskNumbers(openTasks)` from `scripts/taskFiles.ts`, use it in `scripts/checkBlockers.ts` in place of any local equivalent, and make `scripts/prepareTasks.ts` accept `--unblocked` by expanding it to those numbers instead of throwing. After this, `--unblocked valid` must drive the same code path as passing the explicit array.

You own only `scripts/taskFiles.ts`, `scripts/checkBlockers.ts`, and `scripts/prepareTasks.ts`. Do not create a skill directory; that is tracked separately.
