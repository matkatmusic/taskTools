# Task 173 plan: route addTaskFiles writes through hashGuardedRewrite, and pass an authoritative root

## Root cause recap (from the brief's confirmed blocker)

`scripts/addTaskFiles.ts` does unlocked read/modify/write on both `.taskTools/tasks.json`
and `.taskTools/run-arguments.json`. `scripts/closeTasks.ts` already exports
`hashGuardedRewrite` (a retry-on-hash-mismatch compare-and-swap) and already uses it for
both of its own writes (`completedTasksPath` and `tasksPath`, lines 116 and 132 of
`scripts/closeTasks.ts`). `addTaskFiles.ts` must route both of its writes through the same
primitive.

Separately: `skills/tackle-tasks/task.workflow.js` currently widens files by shelling out
via `execFileSync('node', ['scripts/addTaskFiles.ts', ...], { cwd: preparedTask.repoRoot })`
where `preparedTask.repoRoot = WORKTREE` (the private per-task worktree, set at
`loadPreparedTask()`, `runPlan`'s `const repoRoot = WORKTREE`). That worktree has its own
independent `.taskTools/tasks.json`, so today's widening lands in the wrong file and never
reaches the authoritative source tasks.json / run-arguments.json. `closeTasks()` already
solves the analogous problem for the merge stage: it takes an explicit `projectRoot`
parameter, and `runMerge()` (task.workflow.js lines 696-698, 709) reads
`rootOccurrence.checkoutPath` from `ARGS.repositoryManifest.occurrences` (before any stage
mutates it) and passes that in as `mainRepoRoot`. `addTaskFiles.ts` must get the same kind
of explicit-root parameter, and `task.workflow.js`'s widen call site must pass the same
`mainRepoRoot` value instead of relying on `cwd`.

## Edits to scripts/addTaskFiles.ts

Full-file rewrite (every line below is an edit; the file is short enough to specify as one
replacement of its entire current content with the new content).

Current lines 1-5:
```
// The only script that appends paths to a task's file list in .taskTools/tasks.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { resolveRunArgumentsPath } from "./prepareTasks.ts";
```
become:
```
// The only script that appends paths to a task's file list in .taskTools/tasks.json.
import { existsSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { leadingTaskNumbers, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { resolveRunArgumentsPath } from "./prepareTasks.ts";
import { hashGuardedRewrite } from "./closeTasks.ts";
```
(`readFileSync`/`writeFileSync` are no longer called directly — `hashGuardedRewrite` does
all reads/writes now. `readTaskFile` is no longer used — see the `runAsCli` rewrite below,
which parses via the same raw-JSON.parse-with-cast convention `closeTasks.ts` already uses
on this same file at its own line 85.)

Lines 6-37 (`FILES_KEY`, `rejectionReason`, `firstRejectedPath`, `appendFiles`) are unchanged
— keep them exactly as read:
```
const FILES_KEY = "files" as const; // repoint here if task 58 splits files into modifiableFiles/readOnlyFiles

// Repo-relative only: blocks a planner-reported path from escaping the ownership boundary.
function rejectionReason(path: string): string | null {
    if (path === "") return "empty path";
    if (isAbsolute(path)) return `absolute path: ${path}`;
    if (path === "." || path === "..") return `path: ${path}`;
    const normalized = normalize(path);
    if (normalized === ".." || normalized.startsWith("../")) return `path outside repo: ${path}`;
    return null;
}

function firstRejectedPath(paths: string[]): string | null {
    for (const path of paths) {
        const reason = rejectionReason(path);
        if (reason) return reason;
    }
    return null;
}

function appendFiles(task: TaskRecord, paths: string[]): void {
    const existing = Array.isArray(task[FILES_KEY]) ? (task[FILES_KEY] as string[]) : [];
    const seen = new Set(existing);
    const merged = [...existing];
    for (const path of paths) {
        if (seen.has(path)) continue;
        seen.add(path);
        merged.push(path);
    }
    task[FILES_KEY] = merged;
}
```

Current lines 39-52:
```
type RunArgumentsSnapshot = { groups: { tasks: { number: number; files: string[] }[] }[] } & Record<string, unknown>;

function refreshRunArgumentsSnapshot(repoRoot: string, tasks: TaskRecord[]): void {
    const argumentsPath = resolveRunArgumentsPath(repoRoot);
    if (!existsSync(argumentsPath)) return;
    const snapshot = JSON.parse(readFileSync(argumentsPath, "utf8")) as RunArgumentsSnapshot;
    const filesByNumber = new Map(tasks.map((task) => [task.taskNumber, (task[FILES_KEY] as string[] | undefined) ?? []]));
    for (const group of snapshot.groups) {
        for (const task of group.tasks) {
            if (filesByNumber.has(task.number)) task.files = filesByNumber.get(task.number)!;
        }
    }
    writeFileSync(argumentsPath, JSON.stringify(snapshot));
}
```
become:
```
type RunArgumentsSnapshot = { groups: { tasks: { number: number; files: string[] }[] }[] } & Record<string, unknown>;

function refreshRunArgumentsSnapshot(
    repoRoot: string,
    tasks: TaskRecord[],
    afterRunArgumentsWriteTmp?: () => void,
): void {
    const argumentsPath = resolveRunArgumentsPath(repoRoot);
    if (!existsSync(argumentsPath)) return;
    const filesByNumber = new Map(tasks.map((task) => [task.taskNumber, (task[FILES_KEY] as string[] | undefined) ?? []]));
    hashGuardedRewrite<RunArgumentsSnapshot>(
        argumentsPath,
        (snapshot) => {
            for (const group of snapshot.groups) {
                for (const task of group.tasks) {
                    const widened = filesByNumber.get(task.number);
                    if (!widened) continue;
                    const merged = [...task.files];
                    const seen = new Set(merged);
                    for (const path of widened) {
                        if (seen.has(path)) continue;
                        seen.add(path);
                        merged.push(path);
                    }
                    task.files = merged;
                }
            }
            return snapshot;
        },
        afterRunArgumentsWriteTmp,
    );
}
```
(The `existsSync` early-return keeps today's behaviour of creating nothing when
run-arguments.json is absent. `filesByNumber` is computed once from the `tasks` array that
`hashGuardedRewrite` already returned for the tasks.json write below, i.e. the array that
actually landed on disk after any retries — not a stale pre-retry snapshot. The merge (not
assign) into `task.files` is what makes this write safe against a second concurrent widener:
each retry attempt re-reads the on-disk snapshot inside `mutate`, so `task.files` always
starts from whatever the other writer already landed, and this writer only adds its own
paths on top — it can never remove an addition a concurrent writer already committed, per
codex's round-1 REJECTED finding that an assignment-based merge could silently erase a
concurrent widening even though the tasks.json write itself was already hash-guarded.)

Current lines 54-77 (`runAsCli` and the bottom guard):
```
function runAsCli(): void {
    const repoRoot = process.cwd();
    const argv = process.argv.slice(2);
    const numbers = leadingTaskNumbers(argv);
    const paths = argv.slice(1);
    const rejected = firstRejectedPath(paths);
    if (rejected) {
        process.stderr.write(`addTaskFiles: rejected ${rejected}\n`);
        process.exit(1);
    }
    const pair = resolveTaskFiles(repoRoot);
    const tasks = readTaskFile(pair.tasksPath);
    const taskNumbers = new Set(tasks.map((task) => task.taskNumber));
    const missing = numbers.filter((number) => !taskNumbers.has(number));
    if (missing.length > 0) {
        process.stderr.write(`addTaskFiles: not found in tasks.json: ${missing.join(", ")}\n`);
        process.exit(1);
    }
    for (const task of tasks) {
        if (numbers.includes(task.taskNumber)) appendFiles(task, paths);
    }
    writeFileSync(pair.tasksPath, JSON.stringify(tasks, null, 2) + "\n");
    refreshRunArgumentsSnapshot(repoRoot, tasks);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
```
become:
```
// Guarded via hashGuardedRewrite; repoRoot mirrors closeTasks()'s projectRoot, not always process.cwd().
export function addTaskFiles(
    taskNumbers: number[],
    paths: string[],
    repoRoot: string = process.cwd(),
    afterTasksWriteTmp?: () => void,
    afterRunArgumentsWriteTmp?: () => void,
): TaskRecord[] {
    const rejected = firstRejectedPath(paths);
    if (rejected) throw new Error(`addTaskFiles: rejected ${rejected}`);
    const pair = resolveTaskFiles(repoRoot);
    const tasks = hashGuardedRewrite<TaskRecord[]>(
        pair.tasksPath,
        (parsedTasks) => {
            const present = new Set(parsedTasks.map((task) => task.taskNumber));
            const missing = taskNumbers.filter((number) => !present.has(number));
            if (missing.length > 0) {
                throw new Error(`addTaskFiles: not found in tasks.json: ${missing.join(", ")}`);
            }
            for (const task of parsedTasks) {
                if (taskNumbers.includes(task.taskNumber)) appendFiles(task, paths);
            }
            return parsedTasks;
        },
        afterTasksWriteTmp,
    );
    refreshRunArgumentsSnapshot(repoRoot, tasks, afterRunArgumentsWriteTmp);
    return tasks;
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const argv = process.argv.slice(2);
    const numbers = leadingTaskNumbers(argv);
    const paths = argv.slice(1);
    try {
        addTaskFiles(numbers, paths, repoRoot);
    } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
        process.exit(1);
    }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
```

Why the run-arguments write is now safe against a concurrent widening (round-1 REJECTED
finding): if writer A's tasks.json write finishes, then writer B fully completes both of its
own writes (tasks.json and run-arguments.json), and only then does A begin its own
run-arguments rewrite, A's `mutate` re-reads the on-disk `run-arguments.json` inside
`hashGuardedRewrite` — the same re-read-inside-mutate pattern the tasks.json write already
relies on. That on-disk snapshot already carries B's addition (B already committed it), and
A's `mutate` merges (via the same seen-set append pattern as `appendFiles`) rather than
assigns, so A's write can only add A's own paths on top of what is already there — it cannot
remove B's addition. The hash guard on this second write still exists to catch a *third*
writer landing in the gap between A's read and A's own rename; the merge-not-assign change is
what stops the assign-based overwrite this test targets, since a hash match alone does not
stop a writer from computing a `next` that discards data it read but chose not to keep.

Why this is safe against the byte-for-byte tests: `firstRejectedPath` and the `missing`
check both `throw` before `hashGuardedRewrite` ever calls `writeFileSync`/`renameSync` — a
throw inside `mutate` propagates straight out of `hashGuardedRewrite` (it happens before
`tmpPath` is even computed), so tasks.json is never touched on either failure path, exactly
like today.

Why the close/widen race is now safe: each retry attempt inside `hashGuardedRewrite` re-reads
`pair.tasksPath` from disk and recomputes `present`/`missing` from those fresh bytes. If a
concurrent `closeTasks()` call removes a task between this call's read and its write, the
post-write hash check fails, the attempt is discarded, and the retry starts from the tasks.json
that already reflects the closure — so a task this call is not explicitly widening can never be
resurrected, because the returned array on every attempt is the current on-disk array, not a
stale snapshot carried across attempts.

`scripts/closeTasks.ts` needs no edit: `hashGuardedRewrite` is already exported (line 53) and
is used exactly as-is.

## Edits to skills/tackle-tasks/task.workflow.js

All edits are inside `runPlan` (current lines 354-398).

Current line 357:
```
  const { execFileSync } = await import('node:child_process')
```
Delete this line entirely — after the edits below, nothing in `runPlan`'s own scope uses
`execFileSync` (the only use was the `execFileSync('node', ['scripts/addTaskFiles.ts', ...])`
call being removed below; every other function in the file does its own separate
`await import('node:child_process')`).

Current line 360:
```
  const { readTaskFile } = await import(pathToFileURL(join(WORKTREE, 'scripts/taskFiles.ts')).href)
```
becomes:
```
  const { addTaskFiles } = await import(pathToFileURL(join(WORKTREE, 'scripts/addTaskFiles.ts')).href)
```
(`readTaskFile` is no longer used in `runPlan` — the widened tasks now come back as the
return value of `addTaskFiles()` itself, read below.)

Current line 361:
```
  const { writeTaskBriefFile } = await import(pathToFileURL(join(WORKTREE, 'scripts/prepareTasks.ts')).href)
```
stays exactly as-is; immediately after it, insert one new line:
```
  const mainRepoRoot = ARGS.repositoryManifest.occurrences.find((o) => o.occurrenceId === '').checkoutPath
```
This mirrors `runMerge`'s own `const mainRepoRoot = rootOccurrence.checkoutPath` (current
line 698), read from `ARGS.repositoryManifest.occurrences` before any stage has mutated
`checkoutPath` (the mutation `runMerge`'s comment warns about, current line 696-697, is done
by `mergeTaskDeepestFirst` at merge time — it has not run yet during the plan stage).

Current lines 382-383:
```
    execFileSync('node', ['scripts/addTaskFiles.ts', JSON.stringify([N]), ...missingFiles], { cwd: preparedTask.repoRoot })
    const widenedTask = readTaskFile(preparedTask.pair.tasksPath).find((entry) => entry.taskNumber === N)
```
become:
```
    const widenedTasks = addTaskFiles([N], missingFiles, mainRepoRoot)
    const widenedTask = widenedTasks.find((entry) => entry.taskNumber === N)
```
This makes the widen call land in the authoritative source tasks.json /
run-arguments.json (via `mainRepoRoot`) instead of the private worktree's own copy, and reads
the widened task straight back from `addTaskFiles()`'s return value instead of re-reading the
(now-irrelevant) worktree-local `preparedTask.pair.tasksPath`.

Everything else in `runPlan` — including line 384's
`if (!widenedTask) throw new Error(...)`, line 385's
`writeTaskBriefFile(widenedTask, preparedTask.repoRoot)` (still writes the brief into the
private worktree, which is correct — that's where the planner reads it from), and lines
386-398 — is unchanged.

No other function in `skills/tackle-tasks/task.workflow.js` calls `addTaskFiles.ts` in any
form, so no other edits are needed in this file.

## Edits to tests/addTaskFiles.test.ts

Current lines 1-8:
```
// addTaskFiles.ts: appends repo-relative paths to a task's files array in .taskTools/tasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "addTaskFiles.ts");
```
becomes (two new imports inserted after the `node:path` import, everything else unchanged):
```
// addTaskFiles.ts: appends repo-relative paths to a task's files array in .taskTools/tasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTaskFiles } from "../scripts/addTaskFiles.ts";
import { closeTasks } from "../scripts/closeTasks.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "addTaskFiles.ts");
```

Lines 9-112 (every existing helper and every existing test) are unchanged — keep them
exactly as read. They still drive the CLI via `execFileSync`, which now internally delegates
to the exported `addTaskFiles()` function through `runAsCli()`; their behaviour (dedup order,
multi-task-number append, unknown-number rejection leaving tasks.json byte-for-byte
unchanged, invalid-path rejection leaving tasks.json byte-for-byte unchanged, run-arguments
refresh, run-arguments-absent no-op) is preserved by the rewrite above, as walked through
line-by-line in the "Why this is safe" notes.

At the end of the file (current line 112 is the last line, the closing of the final test's
callback and the `test(...)` call), append two new tests using the direct function import
(needed so the test can inject a callback at the exact race window — the CLI subprocess
gives no such hook, and "start two processes and hope they race" is exactly the non-test the
brief calls out):

```

test("two concurrent widen calls forced to interleave: the second call's write, injected mid-transaction, forces the first to retry so both widenings land", () => {
  const root = makeProjectRoot();
  let innerRan = false;
  addTaskFiles([1], ["from-a.ts"], root, () => {
    if (innerRan) return;
    innerRan = true;
    addTaskFiles([2], ["from-b.ts"], root);
  });
  const tasks = readTasks(root);
  assert.deepEqual(tasks.find((t) => t.taskNumber === 1).files, ["existing.ts", "from-a.ts"]);
  assert.deepEqual(tasks.find((t) => t.taskNumber === 2).files, ["from-b.ts"]);
});

test("a task closes mid-transaction while a different task is being widened: the widen retries onto fresh bytes and does not resurrect the closed task", () => {
  const root = makeProjectRoot();
  writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]\n");
  let closedInline = false;
  addTaskFiles([2], ["shared.ts"], root, () => {
    if (closedInline) return;
    closedInline = true;
    closeTasks([1], "closed during race", root);
  });
  const tasks = readTasks(root);
  assert.equal(tasks.some((t) => t.taskNumber === 1), false);
  assert.deepEqual(tasks.find((t) => t.taskNumber === 2).files, ["shared.ts"]);
  const completed = JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
  assert.equal(completed.some((t: any) => t.taskNumber === 1), true);
});

test("two concurrent widen calls forced to interleave inside the run-arguments write: neither widening's run-arguments entry is erased", () => {
  const root = makeProjectRoot();
  writeFileSync(
    join(root, ".taskTools", "run-arguments.json"),
    JSON.stringify({ groups: [{ tasks: [{ number: 1, files: [] }, { number: 2, files: [] }] }] }),
  );
  let innerRan = false;
  addTaskFiles([1], ["from-a.ts"], root, undefined, () => {
    if (innerRan) return;
    innerRan = true;
    addTaskFiles([2], ["from-b.ts"], root);
  });
  const snapshot = JSON.parse(readFileSync(join(root, ".taskTools", "run-arguments.json"), "utf8"));
  const allFiles = snapshot.groups.flatMap((g: any) => g.tasks).flatMap((t: any) => t.files);
  assert.ok(allFiles.includes("from-a.ts"));
  assert.ok(allFiles.includes("from-b.ts"));
});
```

This test targets the run-arguments write specifically (via the new fifth
`afterRunArgumentsWriteTmp` argument), the same way the first new test targets the tasks.json
write via the fourth argument: the outer call's run-arguments `mutate` has written its tmp
file but not yet renamed it when the hook fires; the hook runs a full second `addTaskFiles`
call (both writes) for task 2 to completion; control returns to the outer call's run-arguments
hash check, which sees the file changed, discards its tmp, and retries — re-reading the
snapshot that already carries task 2's `from-b.ts`, merging in its own `from-a.ts` on top
instead of overwriting, and succeeding on the second attempt. Against the round-1 assign-based
version this same interleaving would have overwritten `from-b.ts` with an empty array captured
before task 2 was ever widened.

Trace of why these two tests deterministically force the interleaving (not a hope-based
race), and pass against the new code:

**Widen/widen test.** `hashGuardedRewrite`'s call order is: read "before" bytes → compute
`next` via `mutate` → write `next` to a tmp file → call `afterWriteTmp` → re-read the real
target path and compare its hash to "before" → rename tmp over the target only if unchanged,
else discard the tmp and retry. The outer `addTaskFiles([1], ["from-a.ts"], root, hook)` call
reaches its `afterWriteTmp` slot (the `hook` argument) after writing its own tmp file but
*before* renaming it over the real tasks.json — the real file on disk is still the original
two-task snapshot at that moment. The hook synchronously calls
`addTaskFiles([2], ["from-b.ts"], root)` (no hook), which reads that still-original file,
appends `from-b.ts` to task 2, and renames its tmp over the real file — completing in full
because nothing else has touched the real file yet. Control returns to the outer call, whose
post-write hash check now sees a file that no longer matches what it read at the start of the
attempt (task 2 changed), so it discards its own tmp and retries: it re-reads the file (now
carrying task 2's `from-b.ts`), reapplies its own mutation (task 1 gets `from-a.ts`), and this
second attempt's write succeeds because nothing changes underneath it this time (`innerRan` is
already `true`, so the hook is a no-op on the second attempt). Final state: task 1 has
`existing.ts, from-a.ts`, task 2 has `from-b.ts` — both widenings present, neither clobbered.

**Close/widen test.** Same mechanism, but the injected concurrent operation is
`closeTasks([1], ...)` instead of a second widen, and the outer call widens task 2 (not task
1) — matching the brief's actual scenario: task A closes while a planner is widening a
*different* task, and the danger is A getting resurrected as a side effect of the planner's
write, not A being widened itself. The outer `addTaskFiles([2], ["shared.ts"], root, hook)`
call's tmp write is done, the real file still holds both tasks; the hook runs `closeTasks`,
which removes task 1 from the real tasks.json (and records it in completedTasks.json) before
the outer call's hash check runs. That hash check sees the file changed and retries: it
re-reads the now-task-1-free file, appends `shared.ts` to task 2 only (task 1 is simply absent
from the array it read, so there is nothing to carry forward and nothing to resurrect), and
its second write succeeds. Final state: task 1 is gone from tasks.json and present in
completedTasks.json, task 2 has `["shared.ts"]`. Against the pre-fix code (a single unlocked
read of the full array, mutate task 2 in memory, write the *entire* stale in-memory array
back unconditionally) this same interleaving would have overwritten the just-closed
tasks.json with a copy of the array that still contains task 1 — resurrecting it. The new
code cannot do that because every retry attempt's array comes from a fresh read, never from
a snapshot carried across the concurrent operation.

## Verification

Run, from the repo root:

```
npx tsc --noEmit
```
Expected: no type errors.

```
npm test
```
Expected: all tests pass, including the three new tests in `tests/addTaskFiles.test.ts`
(reported by name: "two concurrent widen calls forced to interleave: ...", "a task closes
mid-transaction while a different task is being widened: ...", and "two concurrent widen
calls forced to interleave inside the run-arguments write: ...") and every pre-existing test
in that file (dedup order, multi-task append, unknown-task-number rejection, invalid-path
rejection, run-arguments refresh, run-arguments-absent no-op).

```
node --test tests/addTaskFiles.test.ts
```
Expected: 9 tests pass (the 6 pre-existing tests plus the 3 new ones), 0 failures.
