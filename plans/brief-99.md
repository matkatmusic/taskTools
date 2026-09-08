# Task 99: Remap stored difficulty values from the 1-5 scale to the 1-10 scale

## User request

[split-task-child] This task is being created by `/split-task` as one of an already-requested set of 3 children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `scripts/taskFiles.ts`, `scripts/taskArchival.ts`.

TITLE: Remap stored difficulty values from the 1-5 scale to the 1-10 scale

This is child 1 of 3 split out of parent task 66 ("Widen the difficulty scale from 1-5 to 1-10 and add a rate-task skill that scores difficulty and split-worthiness"). This child owns ONLY the one-time data remap of already-stored difficulty numbers. Child 2 rewrites the prose scale anchors; child 3 builds the rate-task skill.

WHAT TO DO: every stored `difficulty` value was written on the old 1-5 scale where 5 meant "hardest". The new scale is 1-10 where 10 means "hardest". Existing values must be remapped, not reinterpreted in place, so old and new tasks stay comparable: double every non-null value — 2 becomes 4, 3 becomes 6, 4 becomes 8, 5 becomes 10, 1 becomes 2. Records with `difficulty: null` stay null.

SCOPE: both .taskTools/tasks.json (open tasks) and .taskTools/completedTasks.json (archived tasks). Note the task lists live under .taskTools/, not the repo root. At the time parent 66 was written, tasks.json held nine open tasks with difficulties [3,4,4,2,3,4,2,3,3] and completedTasks.json held 42 records with `difficulty: null` plus 4 twos, 5 threes, 4 fours and 2 fives — do not rely on those exact counts, they have drifted; the remap must be computed from whatever the files hold at run time.

USER DECISION (amended): the actual .taskTools/tasks.json and .taskTools/completedTasks.json files MUST be updated to the new difficulty range as part of this child. Reporting a command for the user to run later is NOT sufficient — the remap must be applied and land in the diff.

Apply it against the live repo checkout, not a task worktree copy, and re-run it immediately before merging so any task appended by a concurrent session in the meantime is remapped too. Concurrent sessions append to tasks.json constantly and this collision has already been hit twice, so print a before/after preview of every taskNumber whose value will change before writing, and confirm afterwards that the resulting diff touches `difficulty` lines only.

The two owned files are references for building the remap, not files to rewrite: scripts/taskFiles.ts supplies `readTaskFile` and `resolveTaskFiles` for locating and parsing both JSON files, and scripts/taskArchival.ts shows the established write pattern — `JSON.stringify(..., null, 2) + "\n"`. The remap must reuse those helpers and that exact write pattern rather than hand-editing JSON, so trailing-newline and indentation formatting stays byte-identical to what the rest of the tooling produces.

TESTS: no new library test required — this child is a data migration. Verify by dry-running against a temporary copy of both JSON files first and confirming: every non-null value exactly doubled, every null left null, and the re-serialized output differs from the input only on `difficulty` lines. Then apply for real.

DIFFICULTY: 2 on the OLD 1-5 scale (this child runs before the widening lands, and the remap it performs will itself double this number).

BLOCKED BY: nothing.

Child 1 of 3 split from parent task 66. Owns the one-time data migration only; child 2 owns the prose scale anchors (skills/pick-a-task/SKILL.md, skills/create-task/template/taskTemplate.json, skills/split-task/SKILL.md) and child 3 owns the new rate-task skill.

Mapping is a straight doubling of every non-null `difficulty`: 1→2, 2→4, 3→6, 4→8, 5→10. `difficulty: null` records (the bulk of completedTasks.json) are left null. Doubling is chosen over reinterpretation so an old 5 ("hardest" on the retiring scale) lands on 10 ("hardest" on the new scale) and old and new tasks remain directly comparable when pick-a-task sorts ascending.

Both task lists live under .taskTools/, not the repo root: .taskTools/tasks.json and .taskTools/completedTasks.json.

Deliverable is the applied migration itself: both .taskTools/tasks.json and .taskTools/completedTasks.json must come out of this task holding remapped values. An unapplied "here is the command to run" hand-off does not satisfy this child (explicit user amendment overriding parent 66's original report-only phrasing).

Worktree hazard remains real: concurrent sessions append to tasks.json continuously and this collision was hit twice during work on parent 66. Mitigate rather than defer — run the remap against the live repo checkout rather than a worktree copy, print a preview listing each taskNumber with its before and after value before writing, and re-run immediately prior to merge so late-appended tasks are caught.

The two owned files are references for building the remap, not edit targets. scripts/taskFiles.ts exports `readTaskFile` and `resolveTaskFiles`, which resolve and parse both JSON files; scripts/taskArchival.ts establishes the serialization contract used by every writer in the repo — `JSON.stringify(value, null, 2) + "\n"`. Reusing both keeps the remapped files byte-identical in formatting to what the rest of the tooling emits, so the diff shows only `difficulty` lines.

No code changes are required for the widened range itself: no script validates or bounds the numeric value, and pick-a-task merely sorts ascending. This child is pure data.

Unblocked.

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

### scripts/taskArchival.ts

```
// Archives fully-published tasks from an explicit list; task 31's approvalGate.ts already gates this, so no re-prompt.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export type RepoPublishStatus = "published" | "conflicted" | "skipped" | "rolled-back";

export interface RepoPublishResult {
    repoName: string;
    status: RepoPublishStatus;
    commitHash?: string;
}

export interface TaskMergeResult {
    taskNumber: number;
    repos: RepoPublishResult[];
    fullyPublished: boolean;
}

export type RawTaskRepoOutcome = {
    taskNumber: number;
    repo: RepoPublishResult;
};

export function summarizeTaskMergeResults(rawOutcomes: RawTaskRepoOutcome[]): TaskMergeResult[] {
    const reposByTask = new Map<number, RepoPublishResult[]>();
    for (const outcome of rawOutcomes) {
        const repos = reposByTask.get(outcome.taskNumber) ?? [];
        repos.push(outcome.repo);
        reposByTask.set(outcome.taskNumber, repos);
    }
    return [...reposByTask.entries()].map(([taskNumber, repos]) => ({
        taskNumber,
        repos,
        fullyPublished: repos.length > 0 && repos.every((repo) => repo.status === "published"),
    }));
}

export function archivePublishedTasks(
    publishedTaskNumbers: number[],
    mergeResults: TaskMergeResult[],
    projectRoot: string = process.cwd(),
): { archived: number[]; leftOpen: number[] } {
    const resultsByTask = new Map(mergeResults.map((result) => [result.taskNumber, result]));
    const considered = new Set<number>([...publishedTaskNumbers, ...mergeResults.map((result) => result.taskNumber)]);

    const archived: number[] = [];
    for (const taskNumber of new Set(publishedTaskNumbers)) {
        if (resultsByTask.get(taskNumber)?.fullyPublished) archived.push(taskNumber);
    }
    const leftOpen = [...considered].filter((taskNumber) => !archived.includes(taskNumber));

    if (archived.length > 0) {
        const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
        const tasks = readTaskFile(tasksPath);
        const completedTasks = readTaskFile(completedTasksPath);
        const completionDate = new Date().toISOString().slice(0, 10);
        for (const taskNumber of archived) {
            const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
            if (index === -1) continue;
            const [task] = tasks.splice(index, 1);
            const commitHashes = (resultsByTask.get(taskNumber)?.repos ?? [])
                .filter((repo) => repo.status === "published" && repo.commitHash)
                .map((repo) => repo.commitHash as string);
            completedTasks.push({ ...task, completionDate, commitHashes });
        }
        writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
        writeFileSync(completedTasksPath, JSON.stringify(completedTasks, null, 2) + "\n");
    }

    return { archived, leftOpen };
}

```
