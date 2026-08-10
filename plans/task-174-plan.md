# Task 174 Plan: build the archived record from the guarded removal snapshot (C86-09)

## Root cause (confirmed by reading scripts/closeTasks.ts)

`closeTasks` reads `tasksPath` once at line 86 into `tasks`. That same, potentially
stale, object is then embedded into the `resolved` map's `task` field (lines 104-114)
and used to build the archived record inside the `completedTasksPath` `hashGuardedRewrite`
call (line 121: `const record = { ...task, ... }`). Only afterward does the `tasksPath`
`hashGuardedRewrite` call (lines 132-137) reread the file fresh and filter the task out.
If another writer mutates the task record on disk between the line-86 read and the
`tasksPath` guarded removal, the archived record (built from the line-86 snapshot) and
the removed record (built from the fresh reread) disagree — the stale one is archived.

## Fix

Move the `tasksPath` `hashGuardedRewrite` call so it runs first, and capture the
per-task records from its own fresh `parsedTasks` inside the `mutate` callback (into a
closure variable that is reassigned on every hash-guard retry attempt, so a retry rebuilds
from the retried bytes, never the first read). The `completedTasksPath` write then runs
second, building each archived record by spreading that freshly-captured record together
with `resolved`'s caller-supplied `closureNote`/`commitHashes` (those are not part of the
racing record, per the brief, so they still come from `resolved`).

To make this race deterministically testable (Node's built-in `fs` module cannot be
mocked for ESM named imports without the `--experimental-test-module-mocks` flag, which
this repo's `npm test` script does not pass — confirmed by running a throwaway repro; see
Verification), `closeTasks` gains one new optional trailing parameter,
`afterTasksWriteAttempt`, threaded straight into the `tasksPath` `hashGuardedRewrite`
call's existing `afterWriteTmp` slot. It is `undefined` for every real caller (the CLI
block at the bottom of the file passes only 4 args), so production behavior is unchanged;
tests use it to make another writer mutate `tasks.json` mid-close, the same technique the
existing `hashGuardedRewrite` retry test already uses directly.

## Edits to scripts/closeTasks.ts

### Edit 1 — function signature (current lines 79-84)

Current text:
```
export function closeTasks(
  taskNumbers: number[],
  closureNote: string | Record<number, string>,
  projectRoot: string = process.cwd(),
  commitHashes: string[] | Record<number, string[]> = [],
): CloseTasksResult {
```

New text:
```
export function closeTasks(
  taskNumbers: number[],
  closureNote: string | Record<number, string>,
  projectRoot: string = process.cwd(),
  commitHashes: string[] | Record<number, string[]> = [],
  // Test-only: fires after the tasksPath tmp write, before the hash-guard rename check.
  afterTasksWriteAttempt?: () => void,
): CloseTasksResult {
```

### Edit 2 — drop the stale `task` field from `resolved` (current lines 104-114)

Current text:
```
  // Resolve every note/hashes/record first, so a missing Record entry throws before any write.
  const resolved = new Map(
    willClose.map((taskNumber) => [
      taskNumber,
      {
        task: tasks.find((task) => task.taskNumber === taskNumber)!,
        closureNote: noteFor(closureNote, taskNumber),
        commitHashes: hashesFor(commitHashes, taskNumber),
      },
    ]),
  );
```

New text:
```
  // Resolve every note/hashes first, so a missing Record entry throws before any write.
  const resolved = new Map(
    willClose.map((taskNumber) => [
      taskNumber,
      {
        closureNote: noteFor(closureNote, taskNumber),
        commitHashes: hashesFor(commitHashes, taskNumber),
      },
    ]),
  );
```

(`tasks`, read at line 86, is still used unchanged at line 95 for the eligibility check —
no edit needed there.)

### Edit 3 — swap the write order and build the archive from the fresh snapshot (current lines 116-137)

Current text:
```
  // Written first; upserts, not skips, so a retry overwrites a stale prior-run record.
  hashGuardedRewrite<TaskRecord[]>(completedTasksPath, (parsedCompleted) => {
    const appended = [...parsedCompleted];
    for (const taskNumber of willClose) {
      const { task, closureNote: note, commitHashes: hashes } = resolved.get(taskNumber)!;
      const record = { ...task, completionDate, commitHashes: hashes, closureNote: note };
      const existingIndex = appended.findIndex((t) => t.taskNumber === taskNumber);
      if (existingIndex === -1) {
        appended.push(record);
      } else {
        appended[existingIndex] = record;
      }
    }
    return appended;
  });

  let unblocked: number[] = [];
  hashGuardedRewrite<TaskRecord[]>(tasksPath, (parsedTasks) => {
    const remaining = parsedTasks.filter((task) => !willClose.includes(task.taskNumber));
    unblocked = unblockDependents(remaining, willClose);
    return remaining;
  });
```

New text:
```
  // Written first; freshRecords comes from this guarded snapshot, rebuilt on every retry.
  let freshRecords = new Map<number, TaskRecord>();
  let unblocked: number[] = [];
  hashGuardedRewrite<TaskRecord[]>(
    tasksPath,
    (parsedTasks) => {
      freshRecords = new Map(
        willClose.map((taskNumber) => [taskNumber, parsedTasks.find((task) => task.taskNumber === taskNumber)!]),
      );
      const remaining = parsedTasks.filter((task) => !willClose.includes(task.taskNumber));
      unblocked = unblockDependents(remaining, willClose);
      return remaining;
    },
    afterTasksWriteAttempt,
  );

  // Upserts, not skips, so a retry overwrites a stale prior-run record.
  hashGuardedRewrite<TaskRecord[]>(completedTasksPath, (parsedCompleted) => {
    const appended = [...parsedCompleted];
    for (const taskNumber of willClose) {
      const { closureNote: note, commitHashes: hashes } = resolved.get(taskNumber)!;
      const record = { ...freshRecords.get(taskNumber)!, completionDate, commitHashes: hashes, closureNote: note };
      const existingIndex = appended.findIndex((t) => t.taskNumber === taskNumber);
      if (existingIndex === -1) {
        appended.push(record);
      } else {
        appended[existingIndex] = record;
      }
    }
    return appended;
  });
```

No other lines in scripts/closeTasks.ts change. `hashGuardedRewrite` itself (lines 54-77),
`noteFor`/`hashesFor` (lines 22-39), the CLI block (lines 160-175, still calling `closeTasks`
with at most 4 args, so `afterTasksWriteAttempt` is `undefined` there), and everything else
are untouched.

## Edits to tests/closeTasks.test.ts

Append one new test after the final `});` on line 175 (end of file), separated by a blank
line, so it reads:

```
test("a task record widened by another writer (e.g. addTaskFiles) mid-close is archived with the NEW fields, not the stale ones read at the start of closeTasks", () => {
  const root = mkdtempSync(join(tmpdir(), "taskTools-close-"));
  writeFileSync(join(root, "tasks.json"), JSON.stringify([{ taskNumber: 65, title: "second", files: ["a.ts"] }]));
  writeFileSync(join(root, "completedTasks.json"), "[]");

  let widened = false;
  const { closed } = closeTasks([65], "fixed by abc123", root, [], () => {
    if (widened) return;
    widened = true;
    writeFileSync(
      join(root, "tasks.json"),
      JSON.stringify([{ taskNumber: 65, title: "second", files: ["a.ts", "b.ts"] }]),
    );
  });

  assert.deepEqual(closed, [65]);
  const completed = readCompleted(root).find((t) => t.taskNumber === 65);
  assert.deepEqual(completed.files, ["a.ts", "b.ts"]);
});
```

No other lines in tests/closeTasks.test.ts change. The new test reuses
`mkdtempSync`/`writeFileSync`/`join`/`tmpdir`/`closeTasks`/`readCompleted`, all already
imported or defined earlier in the file (`readCompleted` at lines 27-29) — no new imports
needed.

### Why this test proves the fix (and would fail without it)

`afterTasksWriteAttempt` fires inside `hashGuardedRewrite`'s loop after the tmp file for
`tasksPath` is written but before the pre-rename hash re-check (mirrors the existing
"hashGuardedRewrite detects a concurrent rewrite" test at lines 130-151, driven through
`closeTasks` this time instead of directly). On attempt 1, `mutate` runs against the
original `files: ["a.ts"]` content; the hook then overwrites `tasks.json` on disk with
`files: ["a.ts", "b.ts"]`; the post-write hash check now mismatches, so `hashGuardedRewrite`
discards the tmp file and retries. On attempt 2, the fresh `readFileSync` picks up the
widened content, `mutate` runs again (rebuilding `freshRecords` from the widened row), the
hook is a no-op the second time, hashes match, and the rename succeeds. The archived record
is then built from `freshRecords`, so it carries `files: ["a.ts", "b.ts"]`. Under the current
(unfixed) code, the archived record is built from `resolved`'s `task` field, which was
captured from the line-86 read taken before the hook ever ran — `files: ["a.ts"]` — so this
test fails against the current code and passes only after Edits 1-3 are applied.

## Verification

Run from the repo root:

```
npm test
```

Expected: every test in `tests/closeTasks.test.ts` passes, including the new
`"a task record widened by another writer (e.g. addTaskFiles) mid-close is archived with
the NEW fields, not the stale ones read at the start of closeTasks"` test, and no other
test file's results change. `node --test` prints a final summary line `fail 0`.

As a targeted check, run just this file:

```
node --test tests/closeTasks.test.ts
```

Expected: `ℹ pass 8`, `ℹ fail 0` (the existing 7 tests plus the 1 new test).

## Confirmed infeasible approach (recorded so it isn't re-attempted)

Mocking `node:fs`'s `readFileSync` from the test, to simulate the race without adding
`afterTasksWriteAttempt`, was tried and rejected:
- `t.mock.method(fsNamespace, "readFileSync", ...)` throws `TypeError: Cannot redefine
  property: readFileSync` (ES namespace objects for `import * as ns from "node:fs"` are
  frozen).
- Mutating the CJS `require("fs")` object's `readFileSync` property does not affect code
  elsewhere that did `import { readFileSync } from "node:fs"` — the two do not share a live
  binding in this Node version.
- `mock.module("node:fs", ...)` (both as `t.mock.module` and the top-level `mock.module`
  from `node:test`) is not a function unless the process is started with
  `--experimental-test-module-mocks`, and `package.json`'s `test` script
  (`node --test "tests/**/*.test.ts"`) does not pass that flag — and `package.json` is
  outside this task's owned files, so it cannot be changed to add it.

All three were confirmed by running throwaway repros in the scratchpad directory before
settling on the `afterTasksWriteAttempt` parameter.
