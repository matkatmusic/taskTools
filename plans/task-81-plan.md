# Task 81 plan: fold unblockDependents into closeTasks

## Decision on the extracted function's signature

The brief's first mention ("taking the closed numbers and a project root") and its
later, more specific instruction ("Do not call the extracted function in a way
that re-reads the file — pass it the already-loaded array") conflict. The later
instruction is authoritative: `unblockDependents` becomes a pure function over an
already-loaded `tasks` array plus the closed task numbers. It does not resolve
paths or touch the filesystem. Signature:

```ts
export function unblockDependents(tasks: any[], closedTaskNumbers: number[]): number[]
```

`tasks: any[]` (not a named `Task` type) because no owned file declares or exports
a `Task` type visible here, and `tests/closeTasks.test.ts` already uses `any[]`
for the same array shape (its `readTasks`/`readCompleted` helpers), so this
matches existing codebase convention rather than introducing a new one.

## File-by-file edits

### scripts/unblockDependents.ts — full-file replacement

Current file (25 lines, read in full). Header comment condensed to one line
here only to satisfy this repo's comment-length hook; the implementer does
not need it to match, since this file's edit is a full overwrite via Write,
not an Edit with old_string matching:

```
// unblockDependents.ts: removes just-closed task numbers from blockedBy arrays.
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

Use Write to overwrite the entire file with:

```
// Removes the given (just-closed) task numbers from every tasks.json entry's
// blockedBy array, dropping the field when it empties. closeTasks.ts calls
// unblockDependents() directly on its in-memory tasks array before writing;
// the CLI entry point below re-reads/rewrites tasks.json for standalone use.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export function unblockDependents(tasks: any[], closedTaskNumbers: number[]): number[] {
  const closed = new Set(closedTaskNumbers.map(Number));
  const unblocked: number[] = [];
  for (const t of tasks) {
    if (!Array.isArray(t.blockedBy)) continue;
    const remaining = t.blockedBy.filter((n: number) => !closed.has(Number(n)));
    if (remaining.length === t.blockedBy.length) continue;
    unblocked.push(t.taskNumber);
    if (remaining.length === 0) delete t.blockedBy;
    else t.blockedBy = remaining;
  }
  return unblocked;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const closed = new Set((process.argv.slice(2).join(" ").match(/\d+/g) ?? []).map(Number));
  if (closed.size === 0) {
    process.stderr.write("usage: node unblockDependents.ts <taskNumber...>\n");
    process.exit(1);
  }

  const { tasksPath } = resolveTaskFiles(process.cwd());
  const tasks = readTaskFile(tasksPath);
  const unblocked = unblockDependents(tasks, [...closed]);
  if (unblocked.length > 0) writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
  process.stdout.write((unblocked.length > 0 ? `removed closed task(s) from blockedBy of task(s): ${unblocked.join(", ")}` : "no blockedBy references to the closed task(s)") + "\n");
}
```

The `if (process.argv[1] && import.meta.url === \`file://${process.argv[1]}\`)` guard
is copied verbatim from scripts/closeTasks.ts:132 — it is the mechanism that
already lets closeTasks.ts be both imported and run as a CLI, so importing
`unblockDependents` from closeTasks.ts will not re-trigger the CLI branch.
The CLI branch's own behavior (usage message on empty input, conditional write,
identical stdout strings) is unchanged, so tests/unblockDependents.test.ts needs
no edit (see below).

### scripts/closeTasks.ts — four targeted edits

**Edit 1 — add the import.** Current line 3:

```
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
```

Insert immediately after it (new line 4):

```
import { unblockDependents } from "./unblockDependents.ts";
```

**Edit 2 — add `unblocked` to the result type.** Current lines 5-8:

```
export interface CloseTasksResult {
  closed: number[];
  skipped: number[];
}
```

becomes:

```
export interface CloseTasksResult {
  closed: number[];
  skipped: number[];
  unblocked: number[];
}
```

**Edit 3 — fold the unblock pass into the write, before the write.** Current lines 97-111:

```
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
```

becomes:

```
  const closed: number[] = [];
  for (const taskNumber of willClose) {
    const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
    const [task] = tasks.splice(index, 1);
    const { closureNote: note, commitHashes: hashes } = resolved.get(taskNumber)!;
    completedTasks.push({ ...task, completionDate, commitHashes: hashes, closureNote: note });
    closed.push(taskNumber);
  }

  let unblocked: number[] = [];
  if (closed.length > 0) {
    unblocked = unblockDependents(tasks, closed);
    writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
    writeFileSync(completedTasksPath, JSON.stringify(completedTasks, null, 2) + "\n");
  }

  return { closed, skipped, unblocked };
}
```

`tasks` at this point already has the closed entries spliced out (the for-loop
above already ran), matching what the two-step flow produced before: the old
unblockDependents.ts CLI always ran second, re-reading tasks.json after
closeTasks.ts had already written it with closed entries removed. Calling
`unblockDependents(tasks, closed)` on the same in-memory array before the write
reproduces that ordering without the intermediate read/write.

**Edit 4 — report the unblocked numbers in the CLI's stdout.** Current lines 132-144:

```
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

becomes:

```
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const taskNumbers = leadingTaskNumbers([process.argv[2] ?? ""]);
  const closureNote = parseCloseNoteArg(process.argv[3] ?? "");
  const commitHashes = parseCommitHashesArg(process.argv[4]);
  const { closed, skipped, unblocked } =
    commitHashes === undefined
      ? closeTasks(taskNumbers, closureNote)
      : closeTasks(taskNumbers, closureNote, undefined, commitHashes);
  process.stdout.write(
    `closed: ${closed.length > 0 ? closed.join(", ") : "none"}\n` +
      `skipped (already completed or not found): ${skipped.length > 0 ? skipped.join(", ") : "none"}\n` +
      (unblocked.length > 0
        ? `removed closed task(s) from blockedBy of task(s): ${unblocked.join(", ")}\n`
        : "no blockedBy references to the closed task(s)\n"),
  );
}
```

No other lines of scripts/closeTasks.ts change. File grows from 114 lines to
roughly 120 — well inside the 250-line cap, so no split is needed.

### skills/close-tasks/SKILL.md — two edits on one paragraph pair

The brief cites "SKILL.md:20" for both the instruction to drop and the
paragraph to fold from, but the live file (read in full, matches the brief's
quoted fence content verbatim) puts the "Then unblock dependents..." paragraph
at line 18, not 20; line 20 is "Stage the changes but do not commit...", which
is unrelated and unchanged. This plan uses the verified live line numbers.

Current lines 16 and 18 (line 17 is a blank separator between them):

Line 16 ends with:
```
...and reports which numbers it closed and which it skipped (already COMPLETED or not found in either file) — relay the skipped ones to the user.
```

Line 18 (to be removed in full):
```
Then unblock dependents with one run of `node "${CLAUDE_PLUGIN_ROOT}/scripts/unblockDependents.ts" '<the task numbers as a no-space JSON array>'` — keep the quotes, or the shell treats the array as a glob. It removes the closed numbers from every remaining task's `blockedBy` array and reports what it unblocked.
```

Edit: old_string (end of line 16 through all of line 18, spanning the blank
line 17 between them):

```
and reports which numbers it closed and which it skipped (already COMPLETED or not found in either file) — relay the skipped ones to the user.

Then unblock dependents with one run of `node "${CLAUDE_PLUGIN_ROOT}/scripts/unblockDependents.ts" '<the task numbers as a no-space JSON array>'` — keep the quotes, or the shell treats the array as a glob. It removes the closed numbers from every remaining task's `blockedBy` array and reports what it unblocked.
```

new_string:

```
and reports which numbers it closed, which it skipped (already COMPLETED or not found in either file), and which dependent tasks it removed from `blockedBy` as a result — relay the skipped and unblocked ones to the user.
```

This removes the separate-invocation instruction (line 18) entirely, folds its
reporting content into line 16's closing clause, and leaves line 16's blank
separator before line 20 ("Stage the changes...") intact since that blank line
sits outside the old_string span. No other line of SKILL.md changes.

### tests/closeTasks.test.ts — one addition, no other edits

The six existing tests destructure only named fields off the `closeTasks`
result (`closed`, `skipped`) and never assert the full result-object shape, so
adding `unblocked` to `CloseTasksResult` does not break any of them. None of
their fixture tasks carry a `blockedBy` field, so none exercise the new fold —
add one test that does, using its own isolated fixture (not the shared
`makeProjectRoot`, to keep the diff from touching the six existing tests).

Current lines 108-109 (end of the file's last test):

```
  assert.equal(readCompleted(root).length, 1);
});
```

becomes (same two lines, plus a new test appended after):

```
  assert.equal(readCompleted(root).length, 1);
});

test("folds unblockDependents into the same write: closing a task clears it from dependents' blockedBy", () => {
  const root = mkdtempSync(join(tmpdir(), "taskTools-close-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 64, title: "first" },
      { taskNumber: 65, title: "second", blockedBy: [64] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), "[]");

  const { closed, unblocked } = closeTasks([64], "fixed by abc123", root);

  assert.deepEqual(closed, [64]);
  assert.deepEqual(unblocked, [65]);
  const tasks = readTasks(root);
  assert.equal("blockedBy" in tasks.find((t) => t.taskNumber === 65), false);
});
```

`mkdtempSync`, `writeFileSync`, `tmpdir`, `join` are already imported at the
top of this file (lines 4-6); no new imports needed.

### tests/unblockDependents.test.ts — no edit

Both tests drive the script through `execFileSync("node", ["--no-inspect", SCRIPT, ...args], ...)`,
asserting on stdout text (`/task\(s\): 2, 4/`, `/no blockedBy references/`) and
on the written tasks.json. The rewritten scripts/unblockDependents.ts CLI
branch preserves the exact same stdout strings and the exact same write
condition (write only when `unblocked.length > 0`), so both assertions still
hold unchanged. No source line in this test file needs to change.

## Verification

Run from /Users/matkatmusicllc/Programming/taskTools:

1. `node --test tests/*.test.ts`
   Expect: all tests pass, including the new closeTasks.test.ts case; the two
   existing unblockDependents.test.ts tests pass unmodified.
2. `npx tsc --noEmit`
   Expect: no type errors (the added `unblocked: number[]` field, the new
   import, and the `any[]` parameter on `unblockDependents` all typecheck).
3. Manual CLI smoke test of the fold, in a scratch directory:
   ```
   mkdir -p /tmp/t81 && cd /tmp/t81
   echo '[{"taskNumber":64,"title":"a"},{"taskNumber":65,"title":"b","blockedBy":[64]}]' > tasks.json
   echo '[]' > completedTasks.json
   node /Users/matkatmusicllc/Programming/taskTools/scripts/closeTasks.ts '[64]' "manual check"
   cat tasks.json
   ```
   Expect stdout to include `closed: 64`, `skipped (already completed or not found): none`,
   and `removed closed task(s) from blockedBy of task(s): 65`; `tasks.json` to
   show task 65 with no `blockedBy` field and task 64 absent (moved to
   completedTasks.json).
</content>
