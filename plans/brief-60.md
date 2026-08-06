# Task 60: Split a task's raw user prompt into userDescription, separate from the agent-derived description

Give a task record two distinct fields instead of one overloaded one. 'userDescription' holds the user's raw prompt verbatim, exactly as typed. 'description' holds only the agent's derived, fleshed-out understanding: file paths, line numbers, root-cause findings, constraints and decisions gathered while writing the task.

Today the two are concatenated into 'description' — the user's wording first, then a blank line, then the agent's expansion — so there is no way to tell afterwards which sentences the user actually wrote and which the agent inferred. That matters when a task is re-read months later and the agent's inference turns out to have been wrong: the user's original intent is the thing that must survive intact.

Changes:

1. skills/create-task/template/taskTemplate.json — add the 'userDescription' key alongside 'description'.

2. skills/create-task/SKILL.md — instruct that 'userDescription' is populated with $ARGUMENTS verbatim and never edited, summarized or reworded, and that 'description' carries only the derived understanding and must not restate the raw prompt.

3. Both existing readers of 'description' must surface the new field under its own heading rather than silently dropping it: scripts/prepareTasks.ts writeTaskBriefFile (line 114, task.description ?? "") and scripts/viewTaskHook.ts (line 11). Treat 'userDescription' as optional, since every existing task in tasks.json and completedTasks.json predates it and has only 'description'.

No migration of existing task records is required or wanted — old tasks keep their combined 'description' and simply have no 'userDescription'.

Note for scheduling: this task edits skills/create-task/SKILL.md and skills/create-task/template/taskTemplate.json, which task 58 also edits, so the two will be grouped into the same worktree rather than run in parallel.

### skills/create-task/SKILL.md

```
---
name: create-task
description: the ONLY way to add a task to tasks.json. ALWAYS invoke this skill whenever any task is being added — whether it comes from the user, from another skill, or from your own work — never edit tasks.json directly. Use discernment — if $ARGUMENTS explains the task well enough, write it directly; if not, refine it with AskUserQuestion (or /grill-me for direction-setting tasks) first.
argument-hint: "<task description>"
---

- taskNumber to use: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`

Task described by the user: $ARGUMENTS

Decide whether that description is actionable later without this conversation's context: a concrete goal or symptom, plus file paths / repro steps / URLs where applicable. If it is, proceed. If not, invoke AskUserQuestion to fill the specific gaps; for a large or direction-setting task, invoke `/grill-me` instead to refine it.

Invoke AskUserQuestion to ask for an example test (most likely an e2e test) that would correctly test the thing being added, offering an option to skip. If the user skips, set the task's `tests` field to the literal string `skip`. Otherwise set `tests` to the user's answer verbatim, as prose or pseudocode — this becomes what the implementing agent writes the test around.

Append ONE object to the `tasks.json` array as its LAST element — at the very end of the array, after every existing entry. Never insert it in the middle and never reorder or renumber the existing entries. Use this template:

```json
!`cat "${CLAUDE_PLUGIN_ROOT}/skills/create-task/template/taskTemplate.json"`
```

Populate `files` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.

If the request names the source note/handoff file(s) the task came from (e.g. an `update-tasks` harvest), also include `"handoffFilePaths": [<those repo-relative paths>]` in the object; otherwise omit the field.

If `specs/SPEC.md` exists and this task belongs to one of its spec items, append the task number to that item's `Tasks:` line.

Omit completion-related fields (`completionDate`, `commitHashes`, `closureNote`) — those belong to `completedTasks.json`, which this skill never touches.

Finally, confirm to the user: the task number and title that were added.

```

### skills/create-task/template/taskTemplate.json

```
{
  "taskNumber": <the injected number above>,
  "title": "<short summary of the task>",
  "description": "<the task in the user's own wording, plus any refinements gathered; include file paths and repro URLs if given>",
  "files": ["<repo-relative path this task will touch>"],
  "tests": "<the user's example test as prose or pseudocode, or the literal string skip>",
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
  "blockedBy": [<task numbers of any tasks that must be completed first; omit the field if none>]
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

### scripts/viewTaskHook.ts

```
// UserPromptSubmit hook: intercepts "/view-task <N...>" and answers it directly with a
// block-decision JSON ({"decision":"block","reason":<text>}), so the prompt never reaches
// the model — zero token cost. The point is readability: tasks.json stores descriptions
// as JSON-escaped one-liners; the block reason prints them with real newlines.
// Any other prompt: exit 0 with empty stdout (silent passthrough).
import { readFileSync } from "node:fs";
import { type TaskRecord, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

function formatTask(task: TaskRecord, status: string): string {
  const lines = [`Task ${task.taskNumber} (${status}): ${task.title ?? ""}`];
  if (task.description) lines.push("", String(task.description));
  const extras = Object.entries(task).filter(([key]) => !["taskNumber", "title", "description"].includes(key));
  if (extras.length > 0) lines.push("");
  for (const [key, value] of extras) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`, ...value.map(item => `  - ${item}`));
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

function describeTask(taskNumber: number, openTasks: TaskRecord[], completedTasks: TaskRecord[]): string {
  const open = openTasks.find(t => t.taskNumber === taskNumber);
  if (open) return formatTask(open, "OPEN");
  const completed = completedTasks.find(t => t.taskNumber === taskNumber);
  if (completed) return formatTask(completed, "COMPLETED");
  return `Task ${taskNumber}: not found in tasks.json or completedTasks.json`;
}

let payload: { prompt?: unknown; cwd?: unknown };
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const prompt = typeof payload.prompt === "string" ? payload.prompt.trimStart() : "";
if (prompt !== "/view-task" && !prompt.startsWith("/view-task ")) process.exit(0);

const root = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
const pair = resolveTaskFiles(root);
const openTasks = readTaskFile(pair.tasksPath);
const completedTasks = readTaskFile(pair.completedTasksPath);

const numbers = (prompt.slice("/view-task".length).match(/\d+/g) ?? []).map(Number);
const reason =
  numbers.length === 0
    ? `Usage: /view-task <N...>\n\nOpen tasks:\n${openTasks.map(t => `  ${t.taskNumber}: ${t.title ?? ""}`).join("\n")}`
    : numbers.map(n => describeTask(n, openTasks, completedTasks)).join("\n\n");
process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");

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
