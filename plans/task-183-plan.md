# Task 183 plan — normalize closing-task numbering in plans/ and add a drift check

## Scope confirmation

Five files are named in this task's fence:

- `plans/brief-156.md`, `plans/task-156-plan.md`, `plans/brief-157.md`,
  `plans/task-157-plan.md` — all four exist on disk today, are untracked in
  git (`git status --porcelain` shows `?? plans/brief-156.md` etc.), and all
  four drift: their filenames and internal task numbers name task 156/157,
  which no longer exist as task records. The renumber mapping (from the
  brief) is `156->162`, `157->163`. `.taskTools/completedTasks.json` confirms
  `taskNumber: 162` (title "addTaskFiles.ts must refresh run-arguments.json
  so the archive gate sees a widened fence" — matches brief-156.md/
  task-156-plan.md's subject) and `taskNumber: 163` (title "tackle-tasks:
  orchestrator drives the merge scheduling queue and deletes the superseded
  workflow files" — matches brief-157.md/task-157-plan.md's subject) both
  exist, at lines 2454 and 2473 of `.taskTools/completedTasks.json`.
- `plans/task-86-spec.md` — read in full. It already reads "Task 163 closed
  this chain" (line 3), "Task 163, the end of the chain, deleted it" (line
  268), and "Task 163 deleted it" (line 272), and "Task 162 predated that
  fix" (line 286). `grep -n '\b15[67]\b' plans/task-86-spec.md` returns no
  matches (confirmed live). This file was already migrated to the new
  numbers by whatever edit produced its current content, so it needs **no
  edit** in this task.
- `tests/planFileNumbering.test.ts` — does not exist on disk. The task
  title ("... and add a drift check") and the brief's references to "the
  drift check" going "red" or being satisfied establish that this task
  creates this file as the drift check itself; it is not an existing file
  being read for reference. Its content is specified in full below.

A live scan (`readdirSync("plans")` matched against `^brief-(\d+)\.md$` /
`^task-(\d+)-plan\.md$`, filenames' numbers checked against the union of
`taskNumber` values in `.taskTools/tasks.json` and
`.taskTools/completedTasks.json`) was run against the repo as it stands now
and returns exactly these 4 drifting files, confirming the brief's "EXACTLY
FOUR FILES DRIFT" claim and that no other `plans/brief-N.md` or
`plans/task-N-plan.md` file drifts:

```
brief-156.md
brief-157.md
task-156-plan.md
task-157-plan.md
```

## Step 1 — rename the four files

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

```
mv plans/brief-156.md plans/brief-162.md
mv plans/task-156-plan.md plans/task-162-plan.md
mv plans/brief-157.md plans/brief-163.md
mv plans/task-157-plan.md plans/task-163-plan.md
```

(Plain `mv`, not `git mv`: all four files are untracked, so there is nothing
for git to move.)

## Step 2 — edit the renamed files' internal task numbers

### 2a. `plans/brief-162.md`, line 1

Current text:
```
# Task 156: addTaskFiles.ts must refresh run-arguments.json so the archive gate sees a widened fence
```
New text:
```
# Task 162: addTaskFiles.ts must refresh run-arguments.json so the archive gate sees a widened fence
```

This is the file's only occurrence of "156" (confirmed: `grep -n '156' plans/brief-156.md` before the rename returns only this line). No other edit to this file.

### 2b. `plans/task-162-plan.md`, line 1

Current text:
```
# Task 156 plan: addTaskFiles.ts refreshes run-arguments.json's files snapshot
```
New text:
```
# Task 162 plan: addTaskFiles.ts refreshes run-arguments.json's files snapshot
```

This is the file's only occurrence of "156" (confirmed: `grep -n '156' plans/task-156-plan.md` before the rename returns only this line). No other edit to this file.

### 2c. `plans/brief-163.md`, line 1

Current text:
```
# Task 157: tackle-tasks: orchestrator drives the merge scheduling queue and deletes the superseded workflow files
```
New text:
```
# Task 163: tackle-tasks: orchestrator drives the merge scheduling queue and deletes the superseded workflow files
```

### 2d. `plans/brief-163.md`, line 25

Current text (one line, exact):
```
RETIRED CODE VS RETIRED FILES. Inside scripts/tackleTasksBrief.ts, instruction text and helpers this task supersedes — the close-tasks skill step, the old "enters the merge queue" ending — are COMMENTED OUT under a `// RETIRED (task 157): ...` header, not deleted. Removing a whole file is the one exception, and it applies only to the five superseded workflow files named above: those five are the only thing in the entire 144-157 chain that leaves the tree.
```
New text (one line, exact):
```
RETIRED CODE VS RETIRED FILES. Inside scripts/tackleTasksBrief.ts, instruction text and helpers this task supersedes — the close-tasks skill step, the old "enters the merge queue" ending — are COMMENTED OUT under a `// RETIRED (task 163): ...` header, not deleted. Removing a whole file is the one exception, and it applies only to the five superseded workflow files named above: those five are the only thing in the entire 144-153 and 163 chain that leaves the tree.
```

Two changes on this line: `task 157` → `task 163` inside the retired-comment
example, and `144-157 chain` → `144-153 and 163 chain`. The second change is
not a bare digit swap: the live `taskNumber: 163` record in
`.taskTools/completedTasks.json` (its `userDescription` field) already
contains this exact phrase, "those five are the only thing in the entire
144-153 and 163 chain that leaves the tree" — the actual chain is task
144-153 plus the renumbered closing task 163, not a continuous 144-163
range, since 154/155/158/159 do not belong to this chain. Matching that
already-true wording keeps the file accurate instead of introducing a new
inaccuracy.

These are the file's only two occurrences of "157" (confirmed via
`grep -n '157' plans/brief-157.md` before the rename: lines 1 and 25 only).
No other edit to this file.

### 2e. `plans/task-163-plan.md`, line 1

Current text:
```
# Task 157 plan — orchestrator drives the merge scheduling queue and deletes the superseded workflow files
```
New text:
```
# Task 163 plan — orchestrator drives the merge scheduling queue and deletes the superseded workflow files
```

### 2f. `plans/task-163-plan.md`, line 21

Current text:
```
   a `// RETIRED (task 157): ...` comment instead of deleting them outright.
```
New text:
```
   a `// RETIRED (task 163): ...` comment instead of deleting them outright.
```

### 2g. `plans/task-163-plan.md`, line 140

Current text:
```
// RETIRED (task 157): superseded by task 152's closeTasks.ts call in the merge stage; kept for reference.
```
New text:
```
// RETIRED (task 163): superseded by task 152's closeTasks.ts call in the merge stage; kept for reference.
```

### 2h. `plans/task-163-plan.md`, line 245 — NOT edited

Current text:
```
after the last existing test (current lines 157–171, the
```

This "157" is a **line-number reference into `tests/runMergePhase.test.ts`**
(the plan is describing where to append new test code, "current lines
157–171"), not a reference to this task's own number. Leave it unchanged.

### 2i. `plans/task-163-plan.md`, line 384

Current text:
```
**Status: complete.** Task 157 closed this chain — the serial tail launches from the orchestrator's generated instructions and the superseded `*.workflow.js` files are deleted.
```
New text:
```
**Status: complete.** Task 163 closed this chain — the serial tail launches from the orchestrator's generated instructions and the superseded `*.workflow.js` files are deleted.
```

### 2j. `plans/task-163-plan.md`, line 406

Current text:
```
  into the `rebase-test` stage (task 145). Task 157, the end of the chain,
```
New text:
```
  into the `rebase-test` stage (task 145). Task 163, the end of the chain,
```

### 2k. `plans/task-163-plan.md`, line 410

Current text:
```
  the implementer's own tests and the tail's full-suite gate. Task 157
```
New text:
```
  the implementer's own tests and the tail's full-suite gate. Task 163
```

`plans/task-163-plan.md`'s occurrences of "157" are exactly lines 1, 21, 140,
245, 384, 406, 410 (confirmed via `grep -n '157' plans/task-157-plan.md`
before the rename). Line 245 is left unedited per 2h; the other six are
edited as above. No other edit to this file.

## Step 3 — create `tests/planFileNumbering.test.ts`

This file does not exist; create it with exactly this content:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTaskFile, resolveTaskFiles } from "../scripts/taskFiles.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function driftingPlanFiles(): string[] {
  const pair = resolveTaskFiles(repoRoot);
  const known = new Set(
    [...readTaskFile(pair.tasksPath), ...readTaskFile(pair.completedTasksPath)].map((task) => task.taskNumber),
  );
  const drift: string[] = [];
  for (const file of readdirSync(join(repoRoot, "plans"))) {
    const match = file.match(/^brief-(\d+)\.md$/) ?? file.match(/^task-(\d+)-plan\.md$/);
    if (match && !known.has(Number(match[1]))) drift.push(file);
  }
  return drift.sort();
}

test("every plans/brief-N.md and plans/task-N-plan.md names a task number that exists in tasks.json or completedTasks.json", () => {
  assert.deepEqual(driftingPlanFiles(), []);
});
```

Design notes (no discovery left for the implementer):

- `resolveTaskFiles` and `readTaskFile` are reused from `scripts/taskFiles.ts`
  (already read in full) rather than re-deriving the `.taskTools/` lookup or
  the JSON-parse-with-fallback logic: `resolveTaskFiles(root)` walks up from
  `root` to find the housing `.taskTools/tasks.json` (falling back to a root
  pair, then to `.taskTools/` under `root`), matching this repo's actual
  layout (`.taskTools/tasks.json`, `.taskTools/completedTasks.json`).
  `readTaskFile(path)` JSON-parses a file and returns `[]` on any read/parse
  failure, so a missing `completedTasks.json` degrades to "no completed
  tasks known" rather than throwing.
- `repoRoot` is derived the same way as `tests/closeTasksBrief.test.ts`
  (`fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")`), an
  established pattern in this test suite for locating the repo root from a
  file under `tests/`.
- The regexes match exactly the two filename shapes named in the brief:
  `brief-N.md` and `task-N-plan.md`. Files that don't match either shape
  (e.g. `plans/task-86-spec.md`, `plans/task-86-codex-audit.md`,
  `plans/p.md`, `plans/reprotest.mjs`) are skipped, not flagged — the brief's
  drift list only ever names files in these two shapes.
- Running this exact check against the repo as it stands before Steps 1-2
  (see "Scope confirmation" above) returns the 4 files this task renames;
  running it after Steps 1-2 apply returns `[]`, because `brief-162.md`,
  `task-162-plan.md`, `brief-163.md`, and `task-163-plan.md` name 162 and
  163, both of which are present in `.taskTools/completedTasks.json`.

No other file needs an edit for this step.

## Files needing no edit

- `plans/task-86-spec.md` — already migrated to task numbers 162/163 (see
  "Scope confirmation" above); contains no remaining reference to 156 or
  157.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

```
ls plans/brief-162.md plans/task-162-plan.md plans/brief-163.md plans/task-163-plan.md
```
Expected: all four paths exist, no error.

```
ls plans/brief-156.md plans/task-156-plan.md plans/brief-157.md plans/task-157-plan.md
```
Expected: `No such file or directory` for all four (the old names are gone).

```
grep -c '15[67]' plans/brief-162.md plans/task-162-plan.md plans/brief-163.md plans/task-163-plan.md
```
Expected: `0` for every file (no leftover references to 156 or 157 as this
task's own number remain; line 245 of `plans/task-163-plan.md`, "current
lines 157–171", is the one accepted exception — rerun as
`grep -n '15[67]' plans/task-163-plan.md` and confirm the only hit left is
that one line naming a line range in another file).

```
npm test -- tests/planFileNumbering.test.ts
```
Expected: 1 pass, 0 failures.

```
npm test
```
Expected: `node --test "tests/**/*.test.ts"` reports 0 failures.
