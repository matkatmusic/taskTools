# Task 152 plan: tackle-tasks — call closeTasks directly, gated on the verified merged commit hash

## Summary of what changes and why

Three owned files change, one does not:

- `scripts/closeTasks.ts` — rewrite its write mechanics to the hash-guarded read/write/rename
  sequence the brief specifies (both for `tasks.json` and `completedTasks.json`, completed file
  first), and export the guarded-rewrite helper so it can be tested directly.
- `skills/tackle-tasks/task.workflow.js` — `runMerge` currently only merges and returns; it must
  now call `closeTasks` directly (no subagent) when, and only when, the merge report's own status
  says `"merged"`, record the actual merged commit hash the merge produced, then call
  `removeWorktreeAndBranch` last. If the merge succeeded but `closeTasks` throws (retries
  exhausted), report a `"merged-but-not-closed"` outcome and do not remove the worktree.
- `tests/closeTasks.test.ts` — add the exported guarded-rewrite helper to the import, add one new
  test proving a concurrent rewrite is detected and retried onto the new bytes without being
  clobbered.
- `scripts/mergeTaskWorktrees.ts` — **no edit**. It already exports `removeWorktreeAndBranch(
  repoRoot, worktreePath, branchName)` (current text, function name only — this file drifts by
  line number through this chain) and `currentBranchName` lives in `./repositoryBranches.ts`,
  already imported there as `import { collectRepositorySources, currentBranchName } from
  "./repositoryBranches.ts";`. This task only needs to *call* what already exists; nothing in this
  file needs to change.

---

## Edit 1 — `scripts/closeTasks.ts`

Replace lines 1–86 (everything from the top of the file through the closing `}` of the `closeTasks`
function) with the text below. Leave lines 87–121 (`parseCloseNoteArg`, `parseCommitHashesArg`, and
the CLI block) exactly as they are — nothing in them changes.

**Current text, line 1:**
```ts
// Moves task numbers from tasks.json to completedTasks.json with a closure note and commit hashes.
import { writeFileSync } from "node:fs";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { unblockDependents } from "./unblockDependents.ts";
```
… through **current text, line 86:**
```ts
}
```
(the closing brace of `export function closeTasks(...)`).

**New text for lines 1–86:**

```ts
// Moves task numbers from tasks.json to completedTasks.json with a closure note and commit hashes.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { leadingTaskNumbers, resolveTaskFiles } from "./taskFiles.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { unblockDependents } from "./unblockDependents.ts";

export interface CloseTasksResult {
  closed: number[];
  skipped: number[];
  unblocked: number[];
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

const MAX_WRITE_RETRIES = 5;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tmpPathFor(targetPath: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.tmp`);
}

// Re-hashes before rename; a mismatch means another writer landed, so this retries onto the new bytes.
// ponytail: detect-and-retry only, the re-hash-to-rename gap is still unsafe; upgrade path is a stale-timeout lockfile.
export function hashGuardedRewrite<T>(
  targetPath: string,
  mutate: (parsed: T) => T,
  afterWriteTmp?: () => void,
): T {
  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
    const before = readFileSync(targetPath);
    const hashBefore = sha256Hex(before);
    const next = mutate(JSON.parse(before.toString("utf8")) as T);
    const tmpPath = tmpPathFor(targetPath);
    writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n");
    afterWriteTmp?.();
    const after = readFileSync(targetPath);
    if (sha256Hex(after) !== hashBefore) {
      unlinkSync(tmpPath);
      continue;
    }
    renameSync(tmpPath, targetPath);
    return next;
  }
  throw new Error(
    `closeTasks: concurrent writes to ${targetPath} prevented an atomic update after ${MAX_WRITE_RETRIES} attempts`,
  );
}

export function closeTasks(
  taskNumbers: number[],
  closureNote: string | Record<number, string>,
  projectRoot: string = process.cwd(),
  commitHashes: string[] | Record<number, string[]> = [],
): CloseTasksResult {
  const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
  const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as TaskRecord[];
  const completionDate = localDate();

  // Duplicates would make the second findIndex return -1 and splice off an unrelated task.
  const uniqueTaskNumbers = [...new Set(taskNumbers)];

  // Eligibility is tasks.json presence only, so a retry after a partial prior write still closes it.
  const skipped: number[] = [];
  const willClose = uniqueTaskNumbers.filter((taskNumber) => {
    const eligible = tasks.some((task) => task.taskNumber === taskNumber);
    if (!eligible) skipped.push(taskNumber);
    return eligible;
  });

  if (willClose.length === 0) {
    return { closed: [], skipped, unblocked: [] };
  }

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

  return { closed: willClose, skipped, unblocked };
}
```

**Why this shape:**
- `readFileSync`/`JSON.parse` replace `readTaskFile` for the guarded paths so the exact bytes that
  get hashed are the exact bytes that get parsed and later re-checked — `readTaskFile` does its own
  separate read, which would defeat the hash guard's premise. `readTaskFile` is dropped from the
  import entirely; nothing else in the file used it.
- The initial `tasks` read (top of `closeTasks`) is a plain, unguarded read — it only decides which
  task numbers are eligible (`willClose`/`skipped`) and snapshots the task records to archive. It
  does not need guarding because it is not a write; the two `hashGuardedRewrite` calls below it
  re-read fresh bytes at every retry attempt regardless. The old `completedTasks`/`completedNumbers`
  reads are dropped: they are no longer used, since eligibility no longer checks
  `completedTasks.json` (see next bullet) and the `completedTasksPath` rewrite below reads its own
  fresh copy inside `hashGuardedRewrite`.
- **Eligibility checks `tasks.json` presence only, not "absent from `completedTasks.json`".** This
  is the fix for a partial-failure retry: if a prior call already wrote `completedTasks.json` but
  then exhausted `MAX_WRITE_RETRIES` on the `tasksPath` write (so the task is now present in *both*
  files), the old `!completedNumbers.has(taskNumber)` condition would mark that task ineligible
  forever — it would never be removed from `tasks.json`, and callers like Edit 2 would see it as
  `skipped` and never clean up. Checking only `tasks.some(...)` means a task still present in
  `tasks.json` is always retried regardless of what `completedTasks.json` says; a task already
  removed from `tasks.json` (the normal fully-closed case) is still correctly ineligible.
- **The `completedTasksPath` rewrite upserts instead of skipping an existing entry.** Previously, if
  `taskNumber` was already present in the freshly-read `parsedCompleted`, the loop did `continue`
  and left the old record untouched. Now it always builds the current `record` (with this call's
  `completionDate`/`commitHashes`/`closureNote`) and either pushes it (not present) or overwrites the
  existing entry at `existingIndex` (present) — so a retry after a partial failure re-writes the
  archived record with the currently supplied merged commit hash instead of leaving a stale one from
  the failed attempt, and never produces a duplicate entry for the same `taskNumber`.
- `resolved` is built, and can throw via `noteFor`/`hashesFor`, entirely before either
  `hashGuardedRewrite` call — preserving the existing "a missing Record entry throws before writing
  either file" guarantee (already covered by the test at original lines 101–109).
- `hashGuardedRewrite` is exported (not exported before) purely so `tests/closeTasks.test.ts` can
  drive the concurrent-write race directly (see Edit 3) without threading a test-only hook through
  `closeTasks`'s public signature, which stays 4 params, unchanged for `task.workflow.js` to call.
- `afterWriteTmp` fires once per attempt, right after the temp file is written and before the
  re-hash — the exact window the brief names as the residual gap ("a writer landing between the
  step 5 re-hash and the step 6 renameSync is still overwritten"). It is unused by `closeTasks`
  itself (both calls omit the third argument) and exists only as the test seam.
- `MAX_WRITE_RETRIES = 5` is the bounded retry count named by the brief's step 5; five is a fixed,
  generous bound for a same-process contention scenario (a second `tackle-tasks` lap writing the
  same file), with no configuration surface since nothing in this task calls for one.

---

## Edit 2 — `skills/tackle-tasks/task.workflow.js`

Replace **current text, lines 670–683**:
```js
const runMerge = async () => {
  log(`task ${N}: merge stage`)
  const repoRoot = process.cwd()
  const { execFileSync } = await import('node:child_process')
  const { existsSync, unlinkSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { mergeTaskDeepestFirst } = await import(pathToFileURL(join(repoRoot, 'scripts/mergeTaskWorktrees.ts')).href)
  const { createEmptyResolutionManifest } = await import(pathToFileURL(join(repoRoot, 'scripts/resolutionRequests.ts')).href)
  cleanupPlanAndBriefFiles(execFileSync, existsSync, unlinkSync, join, repoRoot)
  const manifest = { repositoryManifest: ARGS.repositoryManifest, resolutionManifest: createEmptyResolutionManifest() }
  const { stage: failedAtStage, ...report } = mergeTaskDeepestFirst(repoRoot, manifest)
  return { stage: 'merge', task: N, failedAtStage, ...report }
}
```

with:
```js
const runMerge = async () => {
  log(`task ${N}: merge stage`)
  const repoRoot = process.cwd()
  const { execFileSync } = await import('node:child_process')
  const { existsSync, unlinkSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { mergeTaskDeepestFirst, removeWorktreeAndBranch } = await import(pathToFileURL(join(repoRoot, 'scripts/mergeTaskWorktrees.ts')).href)
  const { createEmptyResolutionManifest } = await import(pathToFileURL(join(repoRoot, 'scripts/resolutionRequests.ts')).href)
  const { currentBranchName } = await import(pathToFileURL(join(repoRoot, 'scripts/repositoryBranches.ts')).href)
  const { closeTasks } = await import(pathToFileURL(join(repoRoot, 'scripts/closeTasks.ts')).href)
  cleanupPlanAndBriefFiles(execFileSync, existsSync, unlinkSync, join, repoRoot)
  const manifest = { repositoryManifest: ARGS.repositoryManifest, resolutionManifest: createEmptyResolutionManifest() }
  const { stage: failedAtStage, ...report } = mergeTaskDeepestFirst(repoRoot, manifest)
  if (report.status !== 'merged') {
    return { stage: 'merge', task: N, failedAtStage, ...report }
  }
  const rootOccurrence = manifest.repositoryManifest.occurrences.find((o) => o.occurrenceId === '')
  const mainRepoRoot = rootOccurrence.checkoutPath
  const sourceBranch = rootOccurrence.baseBranch
  const rootLayer = report.completedLayers.find((layer) => layer.occurrenceId === 'root')
  const mergedCommitHash = rootLayer.oid
  const branch = currentBranchName(repoRoot)
  let closeResult
  try {
    closeResult = closeTasks([N], `merged to ${sourceBranch} at ${mergedCommitHash}`, mainRepoRoot, [mergedCommitHash])
  } catch (error) {
    return { stage: 'merge', task: N, failedAtStage, ...report, status: 'merged-but-not-closed', mergedCommitHash, closeError: String((error && error.message) || error) }
  }
  if (!closeResult.closed.includes(N)) {
    return { stage: 'merge', task: N, failedAtStage, ...report, status: 'merged-but-not-closed', mergedCommitHash, closed: closeResult.closed, skipped: closeResult.skipped, unblocked: closeResult.unblocked }
  }
  try {
    removeWorktreeAndBranch(mainRepoRoot, repoRoot, branch)
  } catch (error) {
    const cleanupWarning = `failed to remove worktree ${repoRoot} and branch ${branch}: ${String((error && error.message) || error)}`
    return { stage: 'merge', task: N, failedAtStage, ...report, mergedCommitHash, closed: closeResult.closed, unblocked: closeResult.unblocked, cleanupWarning }
  }
  return { stage: 'merge', task: N, failedAtStage, ...report, mergedCommitHash, closed: closeResult.closed, unblocked: closeResult.unblocked }
}
```

**Why this shape, and grounding for each piece:**
- **Gate on the report's own status, not on reaching this line.** `mergeTaskDeepestFirst`'s return
  type is a tagged union: `{status:"merged", completedLayers}` or `{status:"submodule-conflicted" |
  "parent-conflicted", ...}` (current text, `scripts/mergeTaskWorktrees.ts` lines 462–480). Checking
  `report.status !== 'merged'` and returning immediately, unchanged from today's behavior, is
  exactly what stops the historical regression the brief names: a blocked/conflicted merge never
  reaches the `closeTasks` call at all. This is the only branch point needed — `task.workflow.js`
  is a plain `.js` file (no TypeScript build step over it), so no type-narrowing concerns apply to
  the plain `report.status === 'merged'` check.
- **The merged commit hash is a genuine read-back, not a guess.** For the root occurrence,
  `mergeTaskDeepestFirst` computes `oid` via `git(sourceCheckoutPath, "rev-parse",
  occurrence.baseBranch).trim()` immediately after the merge commits (current text,
  `scripts/mergeTaskWorktrees.ts` line 603, assigned into `completedLayers` at line 605). Because
  `orderedOccurrences` always ends with the root occurrence (current text, line 524:
  `[...submoduleOccurrencesDeepestFirst, rootOccurrence]`) and every occurrence in that order is
  pushed onto `completedLayers` before the function can return `status: "merged"` (there is no path
  that reaches `return { status: "merged", completedLayers }` on line 608 without every occurrence
  having pushed a layer first), the root's layer — `displayOccurrenceId('')` resolves to `'root'`
  (current text, `mergeTaskWorktrees.ts` lines 454–456) — is always present in `completedLayers`
  when `status === 'merged'`. `report.completedLayers.find((layer) => layer.occurrenceId ===
  'root')` is therefore always found; no fallback branch is written for "not found" because that
  case cannot occur when `report.status === 'merged'`.
- **`mainRepoRoot` and `sourceBranch` come from the manifest, exactly as `runRebaseTest` already
  reads them.** `task.workflow.js`'s own `runRebaseTest` (current text, lines 558–560) does `const
  occurrences = manifest.repositoryManifest.occurrences` then `occurrences.find((o) =>
  o.occurrenceId === '')` for the root occurrence, and reads `.baseBranch` off it for
  `sourceBranch`. This plan reuses that identical pattern. `RepositoryOccurrence.checkoutPath` for
  the root occurrence is the main repository's checkout (the same field `mergeTaskDeepestFirst`
  itself reads at line 511–513 to build `sourceCheckoutPathByOccurrenceId`, keyed the same way) —
  that is the correct `projectRoot` for `closeTasks`, since `.taskTools/tasks.json` lives in the
  main repository, not in this task's disposable worktree (`repoRoot` in this function, i.e.
  `process.cwd()`, which is the worktree the whole `task.workflow.js` script runs from — see
  `runRebaseTest`'s `const worktreePath = preparedTask.repoRoot` at line 556, and `runMerge`'s own
  existing `mergeTaskDeepestFirst(repoRoot, manifest)` call, whose first parameter is named
  `worktreePath` in its own signature at `mergeTaskWorktrees.ts` line 507).
- **`closeTasks` is called directly as plain code** — a same-process function call, not `agent(...)`
  — satisfying "no subagent". It is dynamically imported the same way every other `scripts/*.ts`
  module already is in this same function (`pathToFileURL(join(repoRoot, 'scripts/...')).href`),
  matching the existing `mergeTaskDeepestFirst`/`createEmptyResolutionManifest` import lines
  immediately above it.
- **`commitHashes` argument is `[mergedCommitHash]`.** `closeTasks`'s fourth parameter accepts
  `string[] | Record<number, string[]>` (Edit 1); a plain array applies to every task number in the
  call, and this call only ever closes one task number (`[N]`), so the array form is correct and
  simplest.
- **`currentBranchName`** is imported from `./repositoryBranches.ts`, not
  `./mergeTaskWorktrees.ts` — current text, `scripts/mergeTaskWorktrees.ts` line 7: `import {
  collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";`, and it is called
  elsewhere in that same file as `currentBranchName(worktreePath)` (line 629) and
  `currentBranchName(worktreeSubmodulePath)` (line 424) — a checkout-path argument, returning that
  checkout's current branch name. `currentBranchName(repoRoot)` here returns this task's own branch
  (the "task-N branch" the brief names), because rebasing (which happens earlier in the pipeline,
  in `runRebaseTest`) never changes which branch is checked out in the worktree, only replays its
  commits; and the merge itself runs against the separate main-repo checkout
  (`mainRepoRoot`/`sourceCheckoutPath`), never touching what branch this worktree has checked out.
- **`removeWorktreeAndBranch(mainRepoRoot, repoRoot, branch)` runs last, only after `closeTasks`
  returns successfully.** Current text, `scripts/mergeTaskWorktrees.ts` lines 439–442:
  `export function removeWorktreeAndBranch(repoRoot: string, worktreePath: string, branchName:
  string): void { git(repoRoot, "worktree", "remove", worktreePath, "--force"); git(repoRoot,
  "branch", "-D", branchName); }` — its first parameter is the repo `-C` is run against (the main
  repo, so the `git worktree remove`/`git branch -D` commands succeed regardless of what the
  Node process's own OS working directory happens to be), its second is the worktree path to
  remove (`repoRoot` in this function = `process.cwd()`, the worktree itself), its third the branch
  to delete (`branch`, from `currentBranchName` above). This exact three-argument order/shape is
  already used identically in `mergeTaskWorktrees.ts`'s own `runMergeCli` at line 632:
  `removeWorktreeAndBranch(repoRoot, worktreePath, branch)`.
- **If `closeTasks` throws (the hash guard exhausted its retries), the merge is not unwound.** The
  `try`/`catch` around the `closeTasks` call is the only place `closeTasks` can throw in this
  call path: `noteFor`/`hashesFor` cannot throw here because the call always supplies a plain
  string and a plain one-entry array, never a `Record` missing an entry; the only realistic throw
  is `hashGuardedRewrite`'s "concurrent writes... prevented an atomic update" error (Edit 1) from
  sustained contention. On that throw, the function returns before calling
  `removeWorktreeAndBranch`, so the worktree and branch are left in place for inspection, and
  because `closeTasks` throwing means it never reached its own write calls, the task record is
  still in `tasks.json` — it was never removed. The returned object sets `status:
  'merged-but-not-closed'` (the literal phrase the brief specifies the run must report) plus
  `mergedCommitHash` and `closeError`, for task 149's reporting to consume, per the brief: "Task
  149 owns emitting that outcome; this task owns producing it."
- **If `closeTasks` returns without throwing but `N` is not in `closeResult.closed`, cleanup is
  skipped too.** A non-throwing `closeTasks` call still reports `N` in `closeResult.skipped` instead
  of `closeResult.closed` whenever task `N` was not present in `tasks.json` at the time of the call
  — e.g. a previous run already closed it (a genuine double-run of the merge stage for the same
  task) and this run has stale state. Calling `removeWorktreeAndBranch` in that case would delete
  the worktree/branch for a task this call never actually closed. The `!closeResult.closed.includes(N)`
  check catches that and returns the same `'merged-but-not-closed'` status used for the throw case,
  carrying `closeResult.closed`/`closeResult.skipped`/`closeResult.unblocked` through for task 149's
  reporting, and leaves the worktree and branch in place, same as the throw branch above.
- **`removeWorktreeAndBranch` is wrapped in its own `try`/`catch`, separate from the `closeTasks`
  `try`/`catch` above it.** By the time this call runs, `closeTasks` has already succeeded and `N` is
  confirmed closed — the task is correctly archived and removed from `tasks.json` regardless of what
  happens next. A failure here (e.g. the OS worktree directory is locked or already gone) is a
  cleanup failure, not a close failure: it must not be reported as `'merged-but-not-closed'` (that
  status means "still open, don't treat as done"), because the task genuinely is done. Instead the
  catch returns the normal success shape — `closed`/`unblocked` from `closeResult`, `status` still
  whatever `report` carried (`'merged'`) — plus a `cleanupWarning` string naming the `repoRoot`
  (worktree path) and `branch` that failed to clean up and the caught error, so a human can remove
  them by hand later. Nothing here throws back out of `runMerge`, and nothing re-closes or re-opens
  the task.
- **The non-merged early return is untouched** (`return { stage: 'merge', task: N, failedAtStage,
  ...report }`) — no behavior change for the blocked/conflicted path; the task correctly stays open
  and no worktree/branch removal is attempted, exactly as today.

---

## Edit 3 — `tests/closeTasks.test.ts`

Replace **current text, line 7**:
```ts
import { closeTasks } from "../scripts/closeTasks.ts";
```
with:
```ts
import { closeTasks, hashGuardedRewrite } from "../scripts/closeTasks.ts";
```

Append this new test after **current text, line 129** (the final `});` in the file, which closes
the last existing test — this new test is the last thing in the file:

```ts

test("hashGuardedRewrite detects a concurrent rewrite before rename, retries onto the new bytes, and does not clobber it", () => {
  const root = mkdtempSync(join(tmpdir(), "taskTools-close-"));
  const filePath = join(root, "tasks.json");
  writeFileSync(filePath, JSON.stringify([{ taskNumber: 1 }]));

  let interfered = false;
  const result = hashGuardedRewrite<{ taskNumber: number }[]>(
    filePath,
    (parsed) => [...parsed, { taskNumber: 2 }],
    () => {
      if (interfered) return;
      interfered = true;
      writeFileSync(filePath, JSON.stringify([{ taskNumber: 1 }, { taskNumber: 99 }]));
    },
  );

  assert.deepEqual(result, [{ taskNumber: 1 }, { taskNumber: 99 }, { taskNumber: 2 }]);
  assert.deepEqual(
    JSON.parse(readFileSync(filePath, "utf8")),
    [{ taskNumber: 1 }, { taskNumber: 99 }, { taskNumber: 2 }],
  );
});

test("retrying a task already archived from a prior partial close still removes it from tasks.json, without duplicating or losing the new hash", () => {
  const root = mkdtempSync(join(tmpdir(), "taskTools-close-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([{ taskNumber: 65, title: "second" }]),
  );
  writeFileSync(
    join(root, "completedTasks.json"),
    JSON.stringify([
      { taskNumber: 65, title: "second", completionDate: "2020-01-01", commitHashes: ["stale"], closureNote: "stale note" },
    ]),
  );

  const { closed, skipped } = closeTasks([65], "merged to main at abc123", root, ["abc123"]);

  assert.deepEqual(closed, [65]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(readTasks(root).map((t) => t.taskNumber), []);
  const completed = readCompleted(root).filter((t) => t.taskNumber === 65);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].commitHashes, ["abc123"]);
  assert.equal(completed[0].closureNote, "merged to main at abc123");
});
```

**Why this shape:**
- `mkdtempSync`, `readFileSync`, `writeFileSync`, `tmpdir`, `join` are already imported (current
  text, lines 4–6) — no new imports beyond adding `hashGuardedRewrite` to the existing import from
  `../scripts/closeTasks.ts`.
- The `afterWriteTmp` hook fires exactly once (the `interfered` flag) — this is the point in the
  sequence, per Edit 1, right after the temp file is written and before the re-hash, i.e. exactly
  the window the brief's TEST bullet describes: "a concurrent rewrite of tasks.json landing before
  the step 5 re-hash". Inside it, the test itself plays the role of the concurrent writer,
  overwriting `filePath` with a third-party change (`taskNumber: 99`) that `hashGuardedRewrite` did
  not make and does not know about yet.
- The assertions prove all three brief guarantees at once: `hashBefore` no longer matches on
  re-check, so the guard **detects** the concurrent write; the final file contains `taskNumber: 99`
  (the other writer's own change survives, so it was **not clobbered**); and the final file also
  contains `taskNumber: 2` (the guard's own mutation, re-applied to the freshly re-read bytes on the
  retry attempt, **still lands**).
- This directly exercises `hashGuardedRewrite`, the function both of `closeTasks`'s file writes
  (Edit 1) route through, so it covers the guard for both `tasks.json` and `completedTasks.json`
  without needing two near-identical tests.
- The second new test ("retrying a task already archived from a prior partial close...") exercises
  Edit 1's eligibility and upsert fix directly: it seeds `completedTasks.json` with a stale record
  for task 65 (as a prior partial close would have left it) while task 65 is still present in
  `tasks.json` (as an incomplete `tasksPath` write would have left it), then calls `closeTasks([65],
  ...)` again. The assertions prove the retry is not silently dropped (`closed` includes `65`, not
  `skipped`), that task 65 is actually removed from `tasks.json` this time (`readTasks(root)` is
  `[]`), and that the archived record is overwritten in place rather than duplicated (`completed`
  after filtering to `taskNumber === 65` has length 1) and carries this call's hash and note
  (`["abc123"]`/`"merged to main at abc123"`), not the seeded stale ones.
- No new test is added for "on success, closeTasks records the actual merged commit hash" or "a
  task that was skipped or blocked is still open when the run ends" — both are already covered by
  existing tests in this file: current text, lines 75–80 (`"records the given commit hashes on the
  closed task"`) covers hash recording, and lines 31–52 / 66–73 (siblings `[64, 66]` remain in
  `tasks.json` after closing 65; tasks 60/99 are reported `skipped` and never touched) cover a
  non-closed task staying open. Edit 1 preserves the exact input/output contract those tests assert
  against (verified line-by-line for each of the 7 existing tests below), so they continue to pass
  unmodified. `task.workflow.js`'s `runMerge` (Edit 2) has no test file among this task's owned
  files, and creating one is out of scope.

**Confirmation that all 7 existing tests still pass under Edit 1** (no test file changes needed for
these — listed here as the reasoning, not as edits):
1. *"closes one task, keeps sibling order, writes completionDate/commitHashes/closureNote"* —
   `willClose = [65]`, `completedTasksPath` write appends task 65's record with the resolved note
   and empty `commitHashes` default, `tasksPath` write filters to `[64, 66]` — same fields, same
   order as before.
2. *"duplicate task numbers close the task once and leave siblings alone"* — `uniqueTaskNumbers`
   dedupes `[65, 65]` to `[65]` before anything else runs, unchanged from before.
3. *"skips a task already in completedTasks.json and one absent from both files"* — neither `60`
   (only in `completedTasks.json`) nor `99` (in neither file) is present in `tasks` (the `tasksPath`
   read), so `tasks.some(...)` is false for both and `willClose` is empty — the function returns
   immediately with `skipped: [60, 99]` and performs no file writes at all — `completedTasks.json` is
   left exactly as `makeProjectRoot` wrote it.
4. *"records the given commit hashes on the closed task"* — `hashesFor(["abc123","def456"], 64)`
   returns the array unchanged (the `Array.isArray` branch), stored on the resolved entry and
   spread into the archived record.
5. *"one call with per-task Record note/hashes gives each closed task its own values"* —
   `noteFor`/`hashesFor` are unchanged functions, called per `taskNumber` inside `resolved`'s
   `.map()`, same as before.
6. *"a Record closureNote missing an entry for a closing task throws before writing either file"* —
   `resolved`'s `.map()` calls `noteFor(closureNote, 65)`, which throws before either
   `hashGuardedRewrite` call is reached — no file is touched.
7. *"folds unblockDependents into the same write: closing a task clears it from dependents'
   blockedBy"* — the `tasksPath` `hashGuardedRewrite` mutator computes `remaining` (post-filter,
   same array `unblockDependents` used to receive as `tasks` after the old splice loop) and calls
   `unblockDependents(remaining, willClose)` — identical arguments in identical order to the
   original `unblockDependents(tasks, closed)` call, just derived by `.filter()` instead of a
   splice loop.

---

## Confirmation — `scripts/mergeTaskWorktrees.ts` needs no edit

Every piece this task's other edits depend on already exists, verified by direct reading:
- `removeWorktreeAndBranch(repoRoot: string, worktreePath: string, branchName: string): void`
  (current text, lines 439–442) — called as-is from Edit 2.
- `MergeTaskWalkReport`'s `"merged"` variant carries `completedLayers: MergeLayerOutcome[]`, and
  `MergeLayerOutcome` carries `occurrenceId` and `oid` (current text, lines 458–480) — read as-is in
  Edit 2.
- `mergeTaskDeepestFirst`'s ordering guarantee that the root occurrence's layer is always the last
  element of `completedLayers` on a `"merged"` result (current text, lines 505–609, traced above) —
  relied on as-is in Edit 2.

No line in this file needs to change for any of the above; it is included in this task's file list
because Edit 2 calls into it by name.

---

## Verification

Run each of these from the repository root (`/Users/matkatmusicllc/Programming/taskTools-86`)
after making Edits 1–3. Do not run `bun test` — per this repo's own history, bun reports one false
failure in `mergeTaskWorktrees`; the suite runner is `node --test`, wrapped by `npm test`.

1. **Typecheck `scripts/closeTasks.ts` compiles cleanly:**
   ```
   npx tsc --noEmit
   ```
   Expected: exits 0, no errors reported for `scripts/closeTasks.ts` (or anything else).

2. **`closeTasks.ts`'s own suite, including the new concurrency test, passes:**
   ```
   node --test tests/closeTasks.test.ts
   ```
   Expected: `# pass 9`, `# fail 0` (the 7 existing tests plus the two new ones from Edit 3).

3. **Full suite still green:**
   ```
   npm test
   ```
   Expected: exits 0, no failing tests.

4. **`task.workflow.js` still parses as valid JavaScript** (this file is executed by the pipeline's
   own runner as an async-function body with injected `args`/`agent`/`log` bindings, not run
   directly by Node — constructing it via `AsyncFunction` without invoking it is a pure syntax
   check that needs no stub of those bindings):
   ```
   node -e "const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor; new AsyncFunction('args','agent','log', require('fs').readFileSync('skills/tackle-tasks/task.workflow.js','utf8')); console.log('parsed ok')"
   ```
   Expected: prints `parsed ok`, no thrown `SyntaxError`.

5. **`scripts/mergeTaskWorktrees.ts` is untouched:**
   ```
   git diff --stat scripts/mergeTaskWorktrees.ts
   ```
   Expected: no output (empty diff).
