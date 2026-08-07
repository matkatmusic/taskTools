# Task 64 plan: script-driven close-tasks (no more hand-edited JSON)

## Why (one paragraph, for context only — implementer should not need to re-derive this)

`skills/close-tasks/SKILL.md` currently tells the agent, in prose, to hand-edit `tasks.json` and
`completedTasks.json` with the `Edit` tool. That risks malformed JSON and inconsistent field
shapes. `scripts/taskArchival.ts` already solves the same splice-and-append problem for the
automated merge path, but it derives which tasks to archive from `TaskMergeResult.fullyPublished`
and never writes a `closureNote` — it isn't reusable for manual closure. This plan adds a sibling
script, `scripts/closeTasks.ts`, built the same way (reusing `readTaskFile`/`resolveTaskFiles` from
`scripts/taskFiles.ts`, same `JSON.stringify(..., null, 2) + "\n"` write-back), and points
`skills/close-tasks/SKILL.md` at it instead of the prose move instruction.

## Design decisions locked in (do not re-derive, do not deviate)

1. **`closeTasks()` signature**: `closeTasks(taskNumbers: number[], closureNote: string | Record<number, string>, projectRoot: string = process.cwd(), commitHashes: string[] | Record<number, string[]> = [])`.
   The `taskNumbers`/`projectRoot` positions are unchanged, which is required because the task's
   `tests` field in `.taskTools/tasks.json` calls it as `closeTasks([65], "fixed by abc123", dir)`
   — three positional args, a plain string note, `commitHashes` omitted and defaulting to `[]`.
   That call keeps working unchanged because `string` and `string[]` are still valid members of the
   new union types. `closureNote` and `commitHashes` each accept **either** a single value shared by
   every task number in the call, **or** a `Record<number, ...>` keyed by task number for batches
   that need different notes/hashes per task in one call — this is what satisfies the brief's
   "accept per-task closure notes and commit hashes" literally, not just by giving every task in a
   batch a copy of the same value. When a `Record` is passed, every task number in `taskNumbers`
   that is actually going to be closed (i.e. not skipped) **must** have an entry in it; a missing
   entry throws an `Error` before either JSON file is written (see the resolution-then-write order
   in the implementation below — validation happens in a pass that touches neither `tasks` nor
   `completedTasks`, so a thrown error never leaves a half-written file). The SKILL.md may still
   choose to group tasks that share identical reasoning into one call with a shared string/array,
   or use the `Record` form for a single call covering a batch with different reasoning per task —
   both are documented in the SKILL.md text below, not left to the implementer to invent.

2. **CLI arguments**: three, the third optional, matching the brief's literal invocation
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/closeTasks.ts" '[64,65]' '<closureNote>'` for the two-argument
   case. `process.argv[2]` is the no-space JSON task-number array (unchanged). `process.argv[3]` is
   the closure-note argument: the CLI tries `JSON.parse` on it first — if that succeeds and produces
   a plain object (not an array, not a primitive), it is used as the `Record<number, string>` form;
   otherwise (parse fails, or it parses to something other than a plain object — this is the case for
   ordinary free-text reasoning like `fixed by abc123`, which is not valid JSON) the raw string is
   used as-is as the shared `closureNote`. `process.argv[4]` is optional and carries commit hashes:
   when present it is `JSON.parse`d and used directly — a JSON array becomes the shared
   `commitHashes`, a JSON object becomes the `Record<number, string[]>` form; when absent,
   `commitHashes` is left as `closeTasks`'s own default (`[]`, shared/empty for every task in the
   call). This restores a channel for "search git history for the resolving commits" — the SKILL.md
   below is rewritten to search git history per task and pass what it finds through `argv[4]`
   instead of always leaving it empty; an empty array remains the documented fallback when no commit
   can be identified for a given task.

3. **Skip rule**: a task number is skipped when it is not found in `tasks.json` (covers "absent
   from both") OR it is already present in `completedTasks.json` (covers "already completed").

4. **CLI main-module guard**: use the pattern already established in `scripts/taskStats.ts` /
   `scripts/relatedTests.ts` / `scripts/runMergePhase.ts` / `scripts/prepareTasks.ts` —
   `if (process.argv[1] && import.meta.url === \`file://${process.argv[1]}\`) { ... }` — so that
   `import { closeTasks } from "../scripts/closeTasks.ts"` in the test file does not trigger the
   CLI branch.

## Edits

### 1. Create `scripts/closeTasks.ts` (new file — none of it exists on disk today)

Write this exact content:

```ts
// Moves task numbers from tasks.json to completedTasks.json with a closure note and commit hashes.
import { writeFileSync } from "node:fs";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export interface CloseTasksResult {
  closed: number[];
  skipped: number[];
}

// Local calendar date, not UTC — toISOString() rolls to tomorrow during US evening hours.
function localDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function noteFor(closureNote: string | Record<number, string>, taskNumber: number): string {
  if (typeof closureNote === "string") return closureNote;
  if (!(taskNumber in closureNote)) {
    throw new Error(`closeTasks: no closureNote given for task ${taskNumber}`);
  }
  return closureNote[taskNumber];
}

function hashesFor(
  commitHashes: string[] | Record<number, string[]>,
  taskNumber: number,
): string[] {
  if (Array.isArray(commitHashes)) return commitHashes;
  if (!(taskNumber in commitHashes)) {
    throw new Error(`closeTasks: no commitHashes given for task ${taskNumber}`);
  }
  return commitHashes[taskNumber];
}

export function closeTasks(
  taskNumbers: number[],
  closureNote: string | Record<number, string>,
  projectRoot: string = process.cwd(),
  commitHashes: string[] | Record<number, string[]> = [],
): CloseTasksResult {
  const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
  const tasks = readTaskFile(tasksPath);
  const completedTasks = readTaskFile(completedTasksPath);
  const completedNumbers = new Set(completedTasks.map((task) => task.taskNumber));
  const completionDate = localDate();

  // Duplicates would make the second findIndex return -1 and splice off an unrelated task.
  const uniqueTaskNumbers = [...new Set(taskNumbers)];

  const skipped: number[] = [];
  const willClose = uniqueTaskNumbers.filter((taskNumber) => {
    const eligible =
      tasks.some((task) => task.taskNumber === taskNumber) && !completedNumbers.has(taskNumber);
    if (!eligible) skipped.push(taskNumber);
    return eligible;
  });

  // Resolve every closing task's note/hashes before mutating anything, so a missing Record entry throws before either file is written.
  const resolved = new Map(
    willClose.map((taskNumber) => [
      taskNumber,
      { closureNote: noteFor(closureNote, taskNumber), commitHashes: hashesFor(commitHashes, taskNumber) },
    ]),
  );

  const closed: number[] = [];
  for (const taskNumber of willClose) {
    const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
    const [task] = tasks.splice(index, 1);
    const { closureNote: note, commitHashes: hashes } = resolved.get(taskNumber)!;
    completedTasks.push({ ...task, completionDate, commitHashes: hashes, closureNote: note });
    closed.push(taskNumber);
  }

  if (closed.length > 0) {
    writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
    writeFileSync(completedTasksPath, JSON.stringify(completedTasks, null, 2) + "\n");
  }

  return { closed, skipped };
}

function parseCloseNoteArg(raw: string): string | Record<number, string> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<number, string>;
    }
  } catch {
    // not JSON — treat as a plain free-text closure note
  }
  return raw;
}

function parseCommitHashesArg(raw: string | undefined): string[] | Record<number, string[]> | undefined {
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as string[]) : (parsed as Record<number, string[]>);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const taskNumbers = leadingTaskNumbers([process.argv[2] ?? ""]);
  const closureNote = parseCloseNoteArg(process.argv[3] ?? "");
  const commitHashes = parseCommitHashesArg(process.argv[4]);
  const { closed, skipped } =
    commitHashes === undefined
      ? closeTasks(taskNumbers, closureNote)
      : closeTasks(taskNumbers, closureNote, undefined, commitHashes);
  process.stdout.write(
    `closed: ${closed.length > 0 ? closed.join(", ") : "none"}\n` +
      `skipped (already completed or not found): ${skipped.length > 0 ? skipped.join(", ") : "none"}\n`,
  );
}
```

Notes for the implementer (already resolved, do not re-decide):
- `leadingTaskNumbers` and `readTaskFile`/`resolveTaskFiles` are imported from `./taskFiles.ts`
  exactly as `scripts/getTaskDetails.ts` and `scripts/unblockDependents.ts` already do — do not
  reimplement array-token parsing or file resolution.
- The `completedTasks.push({ ...task, completionDate, commitHashes: hashes, closureNote: note })`
  shape mirrors `scripts/taskArchival.ts` line 64's
  `completedTasks.push({ ...task, completionDate, commitHashes })` precedent exactly, plus the added
  `closureNote` field — `TaskRecord`'s `& Record<string, unknown>` intersection (in
  `scripts/taskFiles.ts` line 7) already permits the extra keys, so no type cast is needed, matching
  how `taskArchival.ts` compiles today.
- `willClose`/`resolved`/the closing loop are three separate passes on purpose: the first determines
  skips without mutating `tasks`, the second resolves (and can throw on) every closing task's
  note/hashes without mutating `tasks`, and only the third splices and pushes — so a `Record` missing
  an entry always throws before `writeFileSync` runs for either file.
- `closeTasks(taskNumbers, closureNote, undefined, commitHashes)` in the CLI branch passes `undefined`
  for `projectRoot` deliberately — JS applies the parameter default (`process.cwd()`) when an argument
  is `undefined`, so this keeps the CLI on the default project root while still supplying `commitHashes`
  positionally.
- `closeTasks([65], "fixed by abc123", dir)` — the exact call the task's `tests` field uses — keeps
  compiling and behaving identically: `closureNote` is a `string`, `commitHashes` is omitted and
  defaults to `[]`, both valid members of the new union types.

### 2. Create `tests/closeTasks.test.ts` (new file — none of it exists on disk today)

Write this exact content (mirrors the structure of `tests/taskArchival.test.ts`: direct function
import, `mkdtempSync`/`readFileSync`/`writeFileSync` round-trip, no `execFileSync`):

```ts
// closeTasks.ts moves closed tasks to completedTasks.json and skips already-completed or absent task numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeTasks } from "../scripts/closeTasks.ts";

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-close-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 64, title: "first" },
      { taskNumber: 65, title: "second" },
      { taskNumber: 66, title: "third" },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 60, title: "already done" }]));
  return root;
}

function readTasks(root: string): any[] {
  return JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
}

function readCompleted(root: string): any[] {
  return JSON.parse(readFileSync(join(root, "completedTasks.json"), "utf8"));
}

test("closes one task, keeps sibling order, writes completionDate/commitHashes/closureNote", () => {
  const root = makeProjectRoot();
  const { closed, skipped } = closeTasks([65], "fixed by abc123", root);

  assert.deepEqual(closed, [65]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    readTasks(root).map((t) => t.taskNumber),
    [64, 66],
  );
  const completed = readCompleted(root).find((t) => t.taskNumber === 65);
  assert.equal(completed.closureNote, "fixed by abc123");
  assert.deepEqual(completed.commitHashes, []);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  assert.equal(
    completed.completionDate,
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  );
  assert.doesNotThrow(() => readTasks(root));
  assert.doesNotThrow(() => readCompleted(root));
});

test("duplicate task numbers close the task once and leave siblings alone", () => {
  const root = makeProjectRoot();
  const { closed } = closeTasks([65, 65], "fixed by abc123", root);

  assert.deepEqual(closed, [65]);
  assert.deepEqual(
    readTasks(root).map((t) => t.taskNumber),
    [64, 66],
  );
  assert.equal(readCompleted(root).filter((t) => t.taskNumber === 65).length, 1);
});

test("skips a task already in completedTasks.json and one absent from both files", () => {
  const root = makeProjectRoot();
  const { closed, skipped } = closeTasks([60, 99], "irrelevant", root);

  assert.deepEqual(closed, []);
  assert.deepEqual(skipped, [60, 99]);
  assert.equal(readCompleted(root).filter((t) => t.taskNumber === 60).length, 1);
});

test("records the given commit hashes on the closed task", () => {
  const root = makeProjectRoot();
  closeTasks([64], "shipped", root, ["abc123", "def456"]);
  const completed = readCompleted(root).find((t) => t.taskNumber === 64);
  assert.deepEqual(completed.commitHashes, ["abc123", "def456"]);
});

test("one call with per-task Record note/hashes gives each closed task its own values", () => {
  const root = makeProjectRoot();
  const { closed, skipped } = closeTasks(
    [64, 65],
    { 64: "fixed by abc123", 65: "verified by user" },
    root,
    { 64: ["abc123"], 65: [] },
  );

  assert.deepEqual(closed, [64, 65]);
  assert.deepEqual(skipped, []);
  const completed64 = readCompleted(root).find((t) => t.taskNumber === 64);
  const completed65 = readCompleted(root).find((t) => t.taskNumber === 65);
  assert.equal(completed64.closureNote, "fixed by abc123");
  assert.deepEqual(completed64.commitHashes, ["abc123"]);
  assert.equal(completed65.closureNote, "verified by user");
  assert.deepEqual(completed65.commitHashes, []);
});

test("a Record closureNote missing an entry for a closing task throws before writing either file", () => {
  const root = makeProjectRoot();
  assert.throws(() => closeTasks([64, 65], { 64: "fixed by abc123" }, root));
  assert.deepEqual(
    readTasks(root).map((t) => t.taskNumber),
    [64, 65, 66],
  );
  assert.equal(readCompleted(root).length, 1);
});
```

### 3. Edit `skills/close-tasks/SKILL.md` — two changes, rest of the file untouched

**Edit 3a — front-matter, line 5.** Current text:

```
allowed-tools: Bash(git add *)
```

becomes:

```
allowed-tools: Bash(git add *), Bash(git log *), Bash(node *)
```

This matches the existing precedent in `skills/tackle-tasks/SKILL.md` line 5
(`allowed-tools: Bash(git add *), Bash(node *)`), the only other skill in this repo that widens
past `Bash(git add *)` to run a node script, with `Bash(git log *)` added so the rewritten
paragraph's "search git history for the commit(s) that resolved each task" instruction is
actually permitted to run.

**Edit 3b — lines 16 through 18.** Current text (three lines: the paragraph, a blank line, and the
skip-reporting line):

```
The decision that these tasks are done has already been made (by the user, or by the skill that invoked this one) — do not re-litigate it. Close every listed OPEN task in a single pass: move its object from `tasks.json` to `completedTasks.json`, adding a `completionDate` (today), `commitHashes` (search git history for the resolving commits; use an empty array if none can be identified), and a short `closureNote` — one sentence per task, using the invoker's reasoning for that specific task where they gave one, their general reasoning otherwise, and "closed manually by user" if they gave none.

Skip tasks already COMPLETED or not found, and say so.
```

becomes (one paragraph, replacing both the move-instruction and the separate skip-reporting line,
since the script now performs and reports both):

```
The decision that these tasks are done has already been made (by the user, or by the skill that invoked this one) — do not re-litigate it. Before closing, search git history for the commit(s) that resolved each task; use an empty array for a task only if none can be identified. Close every listed OPEN task in exactly one invocation of `node "${CLAUDE_PLUGIN_ROOT}/scripts/closeTasks.ts" '[N,N,...]' '<note>' '<hashes>'` — never split the batch across calls: the first argument is every listed task number as one no-space JSON array. The second argument is either one sentence of closure reasoning shared by every task number in that array, or — when tasks in the same call need different reasoning — a no-space JSON object mapping each task number to its own sentence, e.g. `{"64":"fixed by abc123","65":"verified by user"}`; use the invoker's reasoning for that specific task where they gave one, their general reasoning otherwise, and "closed manually by user" if they gave none. The third argument is optional and follows the same shared-vs-per-task shape for the commit hashes found above: a no-space JSON array shared by every task in the call, e.g. `["abc123"]`, or a no-space JSON object mapping each task number to its own array, e.g. `{"64":["abc123"],"65":[]}`; omit this argument (or pass `[]`) only when no task in the call has any commits to record. Use the shared string/array forms only when every task in the batch has identical reasoning and hashes; otherwise use the per-task JSON object forms. Either way it is one call. The script writes today's date as `completionDate` and the resolved `closureNote`/`commitHashes` onto each closed task's record, splices it out of `tasks.json`, appends it to `completedTasks.json`, and reports which numbers it closed and which it skipped (already COMPLETED or not found in either file) — relay the skipped ones to the user.
```

The blank line immediately after (currently line 19, before the "Then unblock dependents..."
paragraph) is unchanged and stays as the single blank line separating this paragraph from the next.

No other lines in `skills/close-tasks/SKILL.md` change: lines 1–4 (front-matter `name`/`description`/
`argument-hint`), line 6 (front-matter close `---`), lines 7–14 (the `getTaskDetails.ts` line and the
three explanatory paragraphs about invocation format, `$ARGUMENTS`, and the verification gate), and
the current lines 20–24 (the `unblockDependents.ts` paragraph, the staging/commit-message paragraph,
and the spec-marking paragraph) are all left exactly as read.

## Files needing no edit, and why

- **`scripts/taskFiles.ts`** — only read from; `closeTasks.ts` imports `leadingTaskNumbers`,
  `readTaskFile`, `resolveTaskFiles` as they exist today, no change needed.
- **`scripts/taskArchival.ts`** — read only for precedent (the `completedTasks.push({ ...task,
  completionDate, commitHashes })` shape and the `JSON.stringify(..., null, 2) + "\n"` write-back);
  the brief explicitly says the user chose a separate file over extending this one, so it is not
  touched.
- **`scripts/getTaskDetails.ts`** — read only for the no-space-JSON-array CLI convention precedent;
  its own behavior (listing/describing tasks) is unrelated to closing them, no change needed.
- **`scripts/unblockDependents.ts`** — read only to confirm the SKILL.md's existing invocation of it
  (line 20, unchanged) still matches its current CLI contract; the brief does not ask for any change
  to it and its behavior (stripping closed numbers from `blockedBy`) is unaffected by this task.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools`:

1. `npx tsc --noEmit -p .`
   Expected: exits 0, no type errors (matches the current clean baseline — this command was run
   before any edits and also exited 0).

2. `node --test tests/closeTasks.test.ts`
   Expected: `# pass 6`, `# fail 0` (six `test(...)` blocks defined above, all passing).

3. `node --test tests/*.test.ts`
   Expected: `# fail 0` — confirms adding `scripts/closeTasks.ts` and editing
   `skills/close-tasks/SKILL.md` did not break any existing test (in particular
   `tests/taskArchival.test.ts`, `tests/unblockDependents.test.ts`, `tests/getTaskDetails.test.ts`,
   `tests/taskFiles.test.ts`, none of which are edited by this plan).

4. Manual CLI smoke test, to exercise the `import.meta.url` CLI branch that the unit tests don't
   reach (they import the function directly):
   ```
   dir=$(mktemp -d)
   echo '[{"taskNumber":1,"title":"a"}]' > "$dir/tasks.json"
   echo '[]' > "$dir/completedTasks.json"
   (cd "$dir" && node "/Users/matkatmusicllc/Programming/taskTools/scripts/closeTasks.ts" '[1]' 'done manually')
   cat "$dir/tasks.json" "$dir/completedTasks.json"
   ```
   Expected: stdout from the script is `closed: 1` then `skipped (already completed or not found): none`;
   `tasks.json` is `[]`; `completedTasks.json` contains one object with `taskNumber: 1`,
   `closureNote: "done manually"`, `commitHashes: []`, and a `completionDate` equal to today
   (2026-08-06 at plan-writing time, but the check should just confirm today's actual date at
   verification time).
