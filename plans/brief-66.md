# Task 66: Widen the difficulty scale from 1-5 to 1-10 and add a rate-task skill that scores difficulty and split-worthiness

## User request

new skill 'rate-task': evaluates a task's description, readOnlyFiles, modifiableFiles and determines the task's difficulty and rates if splitting the task will help, on a scale of 1 to 10, where if the rating is 5 or higher, it suggests split points for use with 'split-task'

PART ONE — widen the difficulty scale from 1-5 to 1-10. The 1-5 anchors are spelled out in exactly two places: skills/create-task/template/taskTemplate.json line 8 (the `difficulty` template comment, currently `1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt`) and skills/pick-a-task/SKILL.md, in the front-matter description on line 3 (`sort by difficulty (1=easiest, 5=hardest)`) and again in the inline anchor list on line 14. Both must be rewritten with ten anchors. No script reads the numeric bound — pick-a-task only sorts ascending on line 16 — so widening the scale needs no code change, only these two prose definitions.

User decision: existing stored values are remapped, not reinterpreted in place, so old and new tasks stay comparable — an old 5 meant 'hardest' and must become 10, 4 becomes 8, 3 becomes 6, 2 becomes 4. At the time of writing, .taskTools/tasks.json holds nine open tasks with difficulties [3,4,4,2,3,4,2,3,3] and .taskTools/completedTasks.json holds 42 records with `difficulty: null` (leave those null) plus 4 twos, 5 threes, 4 fours and 2 fives. Do NOT edit those two JSON files inside a task worktree — concurrent sessions append to tasks.json constantly and this run has already hit that collision twice. Instead the implementer reports the exact one-time remap command for the user to run on the live repo after merge.

PART TWO — the rate-task skill. Both numbers it produces are now on the same 1-10 scale but remain distinct fields: `difficulty` is persisted, the split-worthiness score is not. A task can be hard yet atomic, so a high difficulty must not automatically produce a high split score.

User decision: rate-task writes back. It updates only the task's `difficulty` in .taskTools/tasks.json — note the task list lives under .taskTools/, not the repo root — and reports the 1-10 split score plus any split points in chat. That mutation belongs in a new scripts/rateTask.ts reusing readTaskFile and resolveTaskFiles from scripts/taskFiles.ts and writing with JSON.stringify(..., null, 2) + "\n", the same pattern scripts/taskArchival.ts uses, rather than hand-editing JSON with Edit.

Invocation is `/rate-task <taskNum>`; with no argument it rates every open task, mirroring the optional-argument shape of skills/pick-a-task/SKILL.md line 6. Pull records with `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <N...>`, passing all numbers in one call, exactly as pick-a-task/SKILL.md line 14 does.

Skills are auto-discovered from skills/<name>/SKILL.md — .claude-plugin/plugin.json has no skills array and there is no commands/ directory — so this needs one new skill directory and no manifest edit.

This task's own `difficulty` below is stated on the OLD 1-5 scale, because the widening has not landed yet; the remap pass will double it. Do not re-rate it by hand.

Blocked by two tasks. #58 introduces the `modifiableFiles` / `readOnlyFiles` keys and the shared accessor that falls back to the legacy `files` key; those key names are inputs this skill reads, and they do not exist yet. #65 adds the split-task skill whose `<taskNum> <numSplits>` interface the suggested split points feed into, so the output format has to match what split-task consumes.

### skills/rate-task/SKILL.md

(missing: file not found on disk)

### scripts/rateTask.ts

(missing: file not found on disk)

### tests/rateTask.test.ts

(missing: file not found on disk)

### skills/pick-a-task/SKILL.md

```
---
name: pick-a-task
description: read the open tasks in tasks.json, filter to unblocked, sort by difficulty (1=easiest, 5=hardest), and pick the N lowest-difficulty ones that are still relevant to the current codebase. Report why in under 15 words each. Optional argument N = how many tasks to return.
---

Number of tasks to pick: $ARGUMENTS (default 1 if blank or not a number).

Open tasks: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" | grep ^OPEN`

Blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts"`

Exclude any task reported as BLOCKED in the "Blocked status" above — it is not eligible regardless of difficulty.

For every remaining (non-blocked) open task number, pull its full record in one call — `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <N...>` with all the numbers passed at once — and read each record's `difficulty` field (1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt).

Sort the remaining open tasks by difficulty ascending; break ties by task number ascending. This ordering replaces reasoning about scope; do not re-derive ease from reading the task body.

Starting from the lowest difficulty, for each candidate check the one thing difficulty can't tell you: is it still relevant given the current state of the code? Using the full record already pulled above, check the files listed in its `files` field — has this already been done, or does the premise no longer hold? Skip irrelevant candidates and continue down the sorted list.

Stop once you have N relevant tasks, or the sorted list is exhausted. Report to the user: each task's number, title, difficulty, and a one-line relevance note — under 15 words per task. Do not start implementing any of them.

If fewer than N tasks qualify, report the ones that do and add the line `Only <count> eligible relevant task(s) found.`, then end with the closing lines below using those task numbers. If no task qualifies, report `No eligible relevant tasks found.` and omit the closing lines — there are no task numbers to put in them.

Otherwise end your report with exactly:
`start a session with: 'claude --name "task <N...>"'`
`prompt: "/tackle-tasks [<N,...>] valid"`
where `<N...>` is the chosen task numbers space-separated, and `[<N,...>]` is the same numbers as a JSON array with no spaces (`[268,270]`) — the argument form tackle-tasks and close-tasks require.

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

### skills/split-task/SKILL.md

```
---
name: split-task
description: Break an oversized open task into N smaller child tasks at reasonable split points. Trigger when a task's difficulty is above 3, or its description lists many enumerated steps, and it would be clearer as several smaller tasks.
argument-hint: "<taskNum> <numSplits>"
---

- parent task and file groups: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" info $1 $2`

Parent task number: $1. Number of children to create: $2.

The command above printed the parent task's full record and the $2 file groups `scripts/splitTask.ts` deterministically computed from the parent's `files` array, in order. If that command failed (bad task number, parent already closed, or too few files to split $2 ways), stop here and report the error to the user instead of continuing.

Read the parent's `title`, `description`, and `userDescription`. Decide $2 reasonable split points in the parent's work — logically separable pieces of what the parent asks for — and match each split point, in order, to the file groups printed above: file group 1 becomes child 1's `files`, file group 2 becomes child 2's `files`, and so on. The file grouping itself is fixed by the command's output; the only decision here is which piece of work (child description) goes with each group.

For each of the $2 children, in order, invoke `/create-task` once with that child's description, and explicitly tell `/create-task` in that invocation, verbatim: "[split-task-child] This task is being created by `/split-task` as one of an already-requested set of $2 children — skip the oversized-task assessment regardless of this task's difficulty. This child's `files` field must be exactly this list, in this order, and no other files: `<that child's file group from the command output>`." The literal marker `[split-task-child]` at the start of that sentence is what `skills/create-task/SKILL.md` checks for to bypass its own oversized-task heuristic — every child invocation must carry it, even when a child's own difficulty would otherwise read as 4 or 5 and could trigger another split offer that would break this loop's numbering. Record the task number `create-task` reports back for each child, in the same order as the file groups printed above.

If any `/create-task` invocation fails partway through this loop, stop immediately — do not run the close command, do not retry, and do not invoke `/create-task` for the remaining split points. Report to the user which children were already created (task numbers and titles) and that the parent task ($1) is still open and was not closed, so the user can decide how to clean up the partial children.

Once all $2 children exist, run this command, replacing `<childNumbers>` with the collected child task numbers joined by commas, IN THE SAME ORDER as the file groups printed above:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/splitTask.ts" close $1 $2 <childNumbers>
```

This re-validates the child numbers, recomputes the same deterministic file groups from the parent's current `files` array, then loads each created child and checks that its actual `files` field exactly matches the group assigned to it — only if every child matches does it close the parent, moving it into `completedTasks.json` with `closureNote` set to `Split into <childNumbers>`. If this command fails — including because a child's real `files` field doesn't match its assigned group — report the error to the user and name which child mismatched; the parent was NOT closed and remains open, rather than telling the user the split succeeded.

Finally, confirm to the user: the parent task number that was closed, and the numbers and titles of the children that replaced it.

```
