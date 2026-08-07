# Task 68 Plan: planner-reported missing files, auto-append, brief regen, one retry

## Why (one paragraph, for context only — implementer should not need to re-derive this)

Today `plannerBrief` only lets a planning sub-agent return `needs-clarification` when a
required *edit* falls outside its owned-file list. It has no way to say "I only need to
*read* one more file to finish this plan." Task 64 hit exactly that and a human had to
widen `files` and relaunch by hand. This plan gives the schema a `missingFiles` output,
teaches the prompt to use it for read-only blockers, adds `scripts/addTaskFiles.ts` as the
single place that appends paths to a task's `files` array in `.taskTools/tasks.json`, and
adds one bounded retry in `plan.workflow.js`: append → regenerate the brief → replan once →
accept whatever comes back.

## Files touched

- `skills/tackle-tasks/plan.workflow.js` — edit (4 changes)
- `scripts/addTaskFiles.ts` — create (new file)
- `scripts/prepareTasks.ts` — no edit (reason below)
- `tests/addTaskFiles.test.ts` — create (new file)

---

## 1. `scripts/prepareTasks.ts` — no edit

`writeTaskBriefFile(task: TaskRecord, repoRoot: string): string` is already `export`ed at
line 103 and takes exactly the two arguments the workflow retry needs (a full `TaskRecord`
and the repo root). "Expose or reuse" in the brief is satisfied by reuse: `plan.workflow.js`
imports it directly (see step 3 below). The 250-line cap does not apply — this file gains
zero lines. No hunk in this file changes.

## 2. `tests/addTaskFiles.test.ts` — create

"No tests field, or the literal string 'skip', means do not require TDD" governs *process*
(write the script first, don't red-green it) — it does not mean ship a new state-mutating
CLI with zero regression coverage. `scripts/addTaskFiles.ts` overwrites `.taskTools/tasks.json`
in place; an untested bug there corrupts every task record. This repo's own convention for a
CLI script test (read directly: `tests/checkBlockers.test.ts`, `tests/getTaskDetails.test.ts`,
`tests/archiveProcessed.test.ts`, `tests/planReviewRuling.test.ts`) is `node:test` +
`node:assert/strict`, invoked with `execFileSync("node", ["--no-inspect", SCRIPT, ...args], {
cwd, encoding: "utf8" })` — never `bun:test`, never `bun run`. New file, full contents:

```ts
// addTaskFiles.ts: appends repo-relative paths to a task's files array in .taskTools/tasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "addTaskFiles.ts");

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-addTaskFiles-"));
  mkdirSync(join(root, ".taskTools"));
  writeFileSync(
    join(root, ".taskTools", "tasks.json"),
    JSON.stringify(
      [
        { taskNumber: 1, title: "first", files: ["existing.ts"] },
        { taskNumber: 2, title: "second", files: [] },
      ],
      null,
      2,
    ) + "\n",
  );
  return root;
}

function tasksPath(root: string): string {
  return join(root, ".taskTools", "tasks.json");
}

function readTasks(root: string): any[] {
  return JSON.parse(readFileSync(tasksPath(root), "utf8"));
}

function run(root: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd: root, encoding: "utf8" });
}

function runExpectingFailure(root: string, ...args: string[]): string {
  try {
    run(root, ...args);
  } catch (error) {
    return String((error as { stderr: string }).stderr);
  }
  assert.fail("expected addTaskFiles.ts to exit non-zero");
}

test("appends new paths in order, deduping against what the task already owns", () => {
  const root = makeProjectRoot();
  run(root, "[1]", "existing.ts", "new.ts");
  const task = readTasks(root).find((t) => t.taskNumber === 1);
  assert.deepEqual(task.files, ["existing.ts", "new.ts"]);
});

test("the same incoming path repeated on one call is appended only once", () => {
  const root = makeProjectRoot();
  run(root, "[2]", "a.ts", "b.ts", "a.ts");
  const task = readTasks(root).find((t) => t.taskNumber === 2);
  assert.deepEqual(task.files, ["a.ts", "b.ts"]);
});

test("a multi-task-number call appends the same paths to every named task", () => {
  const root = makeProjectRoot();
  run(root, "[1,2]", "shared.ts");
  const tasks = readTasks(root);
  assert.deepEqual(tasks.find((t) => t.taskNumber === 1).files, ["existing.ts", "shared.ts"]);
  assert.deepEqual(tasks.find((t) => t.taskNumber === 2).files, ["shared.ts"]);
});

test("an unknown task number exits non-zero and leaves tasks.json byte-for-byte unchanged", () => {
  const root = makeProjectRoot();
  const before = readFileSync(tasksPath(root), "utf8");
  const stderr = runExpectingFailure(root, "[999]", "whatever.ts");
  assert.match(stderr, /not found in tasks\.json: 999/);
  assert.equal(readFileSync(tasksPath(root), "utf8"), before);
});

test("absolute paths and directory traversal are rejected, leaving tasks.json byte-for-byte unchanged", () => {
  const root = makeProjectRoot();
  const before = readFileSync(tasksPath(root), "utf8");
  for (const bad of ["/etc/passwd", "../outside.ts", "a/../../outside.ts", ".", "..", ""]) {
    const stderr = runExpectingFailure(root, "[1]", bad);
    assert.match(stderr, /addTaskFiles: rejected/, `expected rejection for ${JSON.stringify(bad)}`);
  }
  assert.equal(readFileSync(tasksPath(root), "utf8"), before);
});
```

## 3. `scripts/addTaskFiles.ts` — create

New file, full contents:

```ts
// The only script that appends paths to a task's file list in .taskTools/tasks.json.
import { writeFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";

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
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
```

Design notes (why, briefly, for the "why" the user can ask about any line):

- **CLI shape** mirrors `scripts/prepareTasks.ts`'s own convention, read directly in this
  repo at lines 194–196: `const repoRoot = process.cwd(); const pair = resolveTaskFiles(repoRoot); const openTasks = readTaskFile(pair.tasksPath); const requestedNumbers = leadingTaskNumbers(process.argv.slice(2));`.
  Task numbers are passed as a single JSON-array token — confirmed by `prepareTasks.ts`
  line 45's own error text: `"no task numbers given; pass a JSON array with no spaces, e.g. [268,270]"`.
  `leadingTaskNumbers` therefore consumes exactly `argv[0]`; everything after it
  (`argv.slice(1)`) is free for this script's own payload, which here is the list of file
  paths to append. Invocation: `bun scripts/addTaskFiles.ts '[64]' scripts/foo.ts scripts/bar.ts`
  — the task-number argument is quoted so shells (e.g. zsh) do not treat `[64]` as a glob.
- **`FILES_KEY` constant + defensive cast** mirrors the exact pattern already used by
  `declaredFiles()` in `prepareTasks.ts` line 99–101 (`Array.isArray(task.files) ? (task.files as string[]) : []`),
  so it type-checks the same way that already-working code does, and gives task 58 one
  constant to repoint instead of a hunt through the file.
- **Dedup, order-preserving append**: a `seen` set (seeded from `existing`) is checked and
  updated as each incoming path is processed in order, so a path already in `existing`, and
  a path repeated within the new `paths` argument itself (e.g. `new.ts new.ts` on one CLI
  call), are both appended at most once; existing order is untouched and each newly-appended
  path lands at the end exactly once.
- **Repo-relative path validation, checked first**: `firstRejectedPath` runs on `paths`
  before `resolveTaskFiles`/`readTaskFile` are even called, so a rejected path never causes
  a read of `tasks.json`, let alone a write. `isAbsolute` catches `/etc/passwd`-style paths;
  the explicit `"."`/`".."` checks and the `normalize(path)` check together catch every
  traversal shape (`../outside.ts`, `a/../../outside.ts`, bare `".."`) without also rejecting
  an ordinary relative path like `scripts/foo.ts` (whose `normalize` output is unchanged and
  does not start with `"../"`). This closes the gap the reviewer flagged: a planner's
  `missingFiles` entry can otherwise smuggle a path outside the repo into `tasks.json`, and
  from there into a brief's `### <file>` section via `writeTaskBriefFile`.
- **Exit-nonzero on unknown task number**: computed and reported *before* any write, so a
  bad task number never touches `tasks.json` — matches `writeFileSync(pair.tasksPath, ...)`
  only running after the `missing.length > 0` early-exit.
- **Write format** — `JSON.stringify(tasks, null, 2) + "\n"` — is the exact format specified
  in the brief (matching `scripts/taskArchival.ts` and `scripts/unblockDependents.ts`
  conventions cited there).
- **CLI entry guard** — `if (process.argv[1] && import.meta.url === \`file://${process.argv[1]}\`) runAsCli();`
  — copied verbatim from `prepareTasks.ts` line 231, same convention.
- 4-space indentation, double quotes, semicolons: matches `prepareTasks.ts`'s own style
  (read directly, e.g. line 99–101), which this script sits beside.

## 4. `skills/tackle-tasks/plan.workflow.js` — 4 edits

This file uses 2-space indentation, single quotes, and no semicolons throughout (verified
by reading the whole file — e.g. `const GROUPS = ARGS.groups ?? []` has no trailing
semicolon). All new code below matches that style, not the general 4-space TS default,
per "match existing style" in the coding standards.

### Edit 4a — add imports at the top of the file

Current text (file starts at line 1):
```
export const meta = {
```

New text:
```
import { execFileSync } from 'node:child_process'
import { readTaskFile, resolveTaskFiles } from '../../scripts/taskFiles.ts'
import { writeTaskBriefFile } from '../../scripts/prepareTasks.ts'

export const meta = {
```

Why these three imports and these exact specifiers: `execFileSync` is how the workflow
shells out to `addTaskFiles.ts` (brief: "the workflow must shell out to it rather than
editing JSON inline"). `readTaskFile`/`resolveTaskFiles` are needed to re-read the task's
full record after `addTaskFiles.ts` mutates `tasks.json` (the in-memory `t` object in this
file is a `PreparedTask` — `{number, briefFile, planFile, files}` per
`scripts/prepareTasks.ts` line 136-141, read directly — it has no `title`/`userDescription`/
`description`, which `writeTaskBriefFile` requires). `writeTaskBriefFile` is the reused
brief-regeneration function from step 1. The relative path `../../scripts/...` is correct:
this file is at `skills/tackle-tasks/plan.workflow.js`, two directories below the repo root,
and `scripts/` is a direct child of the repo root.

### Edit 4b — add `missingFiles` to `PLAN_SCHEMA`

Current text (lines 11-20):
```
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    status: { type: 'string', enum: ['planned', 'needs-clarification', 'not-relevant'] },
    planFile: { type: 'string' },
    question: { type: 'string' },
  },
  required: ['task', 'status', 'planFile', 'question'],
}
```

New text:
```
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    status: { type: 'string', enum: ['planned', 'needs-clarification', 'not-relevant'] },
    planFile: { type: 'string' },
    question: { type: 'string' },
    missingFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['task', 'status', 'planFile', 'question'],
}
```

`missingFiles` is added to `properties` only, not to `required` — it is optional, populated
only when the blocker is access rather than ambiguity (brief work item 1). No stored task
field is introduced (`missingFiles` is planner output, never written to `tasks.json` itself —
consistent with the brief's constraint that `skills/create-task/template/taskTemplate.json`
stays the source of truth for the task record shape).

### Edit 4c — extend `plannerBrief` prompt text

Current text (lines 26-54, the full `plannerBrief` template literal):
```
const plannerBrief = (t) => `Invoke /ponytail:ponytail ultra.
Read this brief file: ${t.briefFile}
You may also READ these owned files, and nothing else: ${t.files.join(', ')}
Read them — a plan that guesses at their contents will be rejected by the reviewer.
Follow ~/.claude/guides/planning.md and write the plan to exactly this path: ${t.planFile}
Do not change any source file — this is planning only, not implementation.

The plan must be exact enough that the implementer makes no discovery of its own:
- Name every edit by file path and line number, with the current text and what it becomes.
- Account for every owned file: either its exact edit list, or the reason it needs no edit.
- Resolve every question while planning. Write no conditional instruction — no
  "re-check", no "verify before editing", no "if the live file disagrees", no
  "trust the live file". If you could not settle something, that is
  needs-clarification, not a fallback sentence in the plan.
- Quote only text you actually read. Never describe an excerpt the brief does not contain.
- State the verification that proves the change worked, as commands with expected results.
- ${testsInstruction(t)}

If the plan would need to edit a file outside the owned list above, set status
"needs-clarification" and name that file in "question" — do not plan the edit anyway.
If the task is unclear, set status "needs-clarification" and put your
question in "question". If the task no longer applies to the codebase, set
status "not-relevant" and explain why in "question". Otherwise write the
plan file and set status "planned".
Return {task: ${t.number}, status, planFile: "${t.planFile}", question}.

You are forbidden to edit any file other than ${t.planFile}; to read a file outside
the owned list; to leave a decision for the implementer; or to write a plan step
whose exact target you did not read.`
```

New text:
```
const plannerBrief = (t) => `Invoke /ponytail:ponytail ultra.
Read this brief file: ${t.briefFile}
You may also READ these owned files, and nothing else: ${t.files.join(', ')}
Read them — a plan that guesses at their contents will be rejected by the reviewer.
Follow ~/.claude/guides/planning.md and write the plan to exactly this path: ${t.planFile}
Do not change any source file — this is planning only, not implementation.

The plan must be exact enough that the implementer makes no discovery of its own:
- Name every edit by file path and line number, with the current text and what it becomes.
- Account for every owned file: either its exact edit list, or the reason it needs no edit.
- Resolve every question while planning. Write no conditional instruction — no
  "re-check", no "verify before editing", no "if the live file disagrees", no
  "trust the live file". If you could not settle something, that is
  needs-clarification, not a fallback sentence in the plan.
- Quote only text you actually read. Never describe an excerpt the brief does not contain.
- State the verification that proves the change worked, as commands with expected results.
- ${testsInstruction(t)}

If the plan would need to edit a file outside the owned list above, set status
"needs-clarification" and name that file in "question" — do not plan the edit anyway.
If the blocker is instead that you need to READ a file outside the owned list
to write an exact plan, set status "needs-clarification", populate
missingFiles with the repo-relative path(s) of each file you need, and use
"question" to explain why each path is needed.
If the task is unclear, set status "needs-clarification" and put your
question in "question". If the task no longer applies to the codebase, set
status "not-relevant" and explain why in "question". Otherwise write the
plan file and set status "planned".
Return {task: ${t.number}, status, planFile: "${t.planFile}", question, missingFiles}.

You are forbidden to edit any file other than ${t.planFile}; to read a file outside
the owned list; to leave a decision for the implementer; or to write a plan step
whose exact target you did not read.`
```

Two changes inside the template: a new paragraph (right after the existing
edit-outside-owned-list paragraph, since read-access blockers are the same family of
problem) telling the agent when to use `missingFiles`, and the `Return {...}` line now lists
`missingFiles` alongside the four existing fields. The "forbidden" closing paragraph is
unchanged on purpose — the agent is still forbidden from reading outside its current owned
list; `missingFiles` only lets it *ask* for the list to be widened, the retry (edit 4d)
is what actually widens it before the second attempt.

### Edit 4d — bounded retry after the first planning pass

Current text (lines 74-87, the end of the file):
```
const results = await parallel(TASKS.map((t) => () => runPlanner(t)))
const plans = TASKS.map((t, i) => results[i] ?? {
  task: t.number,
  status: 'needs-clarification',
  planFile: '',
  question: 'planner returned no result after 3 attempts',
})

return {
  plans,
  planned: plans.filter((p) => p.status === 'planned'),
  needsClarification: plans.filter((p) => p.status === 'needs-clarification'),
  notRelevant: plans.filter((p) => p.status === 'not-relevant'),
}
```

New text:
```
const results = await parallel(TASKS.map((t) => () => runPlanner(t)))
const firstPass = TASKS.map((t, i) => results[i] ?? {
  task: t.number,
  status: 'needs-clarification',
  planFile: '',
  question: 'planner returned no result after 3 attempts',
})

// Retries a needs-clarification verdict, not a null result; distinct from retryAgent above.
const needsFileRetry = (p) => p.status === 'needs-clarification' && Array.isArray(p.missingFiles) && p.missingFiles.length > 0

const retryWithFiles = async (t, p) => {
  execFileSync('bun', ['scripts/addTaskFiles.ts', JSON.stringify([t.number]), ...p.missingFiles], { cwd: ARGS.repo, stdio: 'inherit' })
  const pair = resolveTaskFiles(ARGS.repo)
  const updated = readTaskFile(pair.tasksPath).find((task) => task.taskNumber === t.number)
  if (!updated) throw new Error(`task ${t.number} disappeared from tasks.json`)
  t.files = [...new Set([
    ...t.files,
    ...(Array.isArray(updated.files) ? updated.files : []),
  ])]
  writeTaskBriefFile(updated, ARGS.repo)
  const retryResult = await runPlanner(t)
  return retryResult ?? {
    task: t.number,
    status: 'needs-clarification',
    planFile: '',
    question: 'planner returned no result after 3 attempts on file retry',
  }
}

const plans = []
for (let i = 0; i < TASKS.length; i++) {
  const result = firstPass[i]
  plans.push(needsFileRetry(result)
    ? await retryWithFiles(TASKS[i], result)
    : result)
}

return {
  plans,
  planned: plans.filter((p) => p.status === 'planned'),
  needsClarification: plans.filter((p) => p.status === 'needs-clarification'),
  notRelevant: plans.filter((p) => p.status === 'not-relevant'),
}
```

Why this shape:

- `firstPass` is the renamed original `plans` (kept as its own variable so the retry step has
  something to read from before the final `plans` name is reassigned).
- `needsFileRetry` gates the retry strictly to "needs-clarification AND non-empty
  missingFiles" — a task that returned needs-clarification for any other reason (ambiguity,
  an edit outside the owned list) is left alone and falls straight through to the final
  `needsClarification` bucket unchanged, exactly as the brief specifies.
- `retryWithFiles` does the three brief-mandated steps in order: (1) shell out to
  `scripts/addTaskFiles.ts` with the task's number and its reported `missingFiles`, using
  `ARGS.repo` as `cwd` — `ARGS.repo` is `WorkflowArguments.repo` (`scripts/prepareTasks.ts`
  line 279-297, `buildWorkflowArguments`, returns `{ repo: repoRoot, ... }`), the same
  repo root `t.briefFile`/`t.planFile` were built from, so briefs/plans/tasks.json all live
  in one place, matching this planning task's own environment (running directly in the repo
  root, not a worktree); (2) re-read the task from `tasks.json`, guard against the task
  having vanished mid-run, and fold the newly-appended `updated.files` into `t.files` via a
  `Set` (union, not replace) before calling the reused `writeTaskBriefFile` to rewrite
  `plans/brief-<n>.md` in place; (3) call `runPlanner(t)` once more — `t.files` was widened
  in step 2 so the regenerated `plannerBrief(t)` (called fresh inside `runPlanner`) reflects
  the widened owned-file list. `runPlanner`'s own `retryAgent` (3 attempts against a null
  harness result) still applies unchanged inside this one call — that mechanism is untouched,
  per the brief's explicit instruction not to overload it.
- **Union, not replace, for `t.files`**: `t` is a `PreparedTask` built from `group.filePaths`
  (`scripts/prepareTasks.ts`'s task-grouping step), which can be a superset of any one task's
  own `files` entry in `tasks.json` — a group may bundle several tasks that together own more
  files than this task alone declares. `updated.files` is only this task's own list (plus the
  newly-appended `missingFiles`). Assigning `t.files = updated.files` would have silently
  dropped every other file the group granted this task access to, narrowing what the retried
  planner is allowed to read. The `Set` union keeps every file `t` already had and adds
  whatever `addTaskFiles.ts` just appended, so the retry only ever grows access, never shrinks
  it. `writeTaskBriefFile` still receives `updated` (not the unioned `t`), per its existing
  contract of writing exactly the file sections a `TaskRecord`'s own `files` field declares —
  the union only widens the *prompt's* owned-file list for the retried `plannerBrief(t)` call.
- **`if (!updated) throw`**: `addTaskFiles.ts` already refuses to run for an unknown task
  number (see step 3), but a task could still disappear between the first planning pass and
  this retry (e.g. a concurrent close). Throwing surfaces that loudly instead of crashing on
  `updated.files` with a confusing "Cannot read properties of undefined" a few lines later.
- The task-number CLI argument is `JSON.stringify([t.number])`, e.g. `"[64]"` for task 64 —
  `JSON.stringify` on an array of numbers produces no spaces by default, matching the "JSON
  array with no spaces" format `addTaskFiles.ts` expects (see step 3).
- **Retries run sequentially, not through `parallel`**: every `retryWithFiles` call reads
  then rewrites the same file, `.taskTools/tasks.json`, via `addTaskFiles.ts` (step 3) and
  `writeTaskBriefFile`. If two tasks both needed a file retry and ran through `parallel`
  (`Promise.all`-style concurrency) at the same time, their `addTaskFiles.ts` invocations
  would each read the pre-append `tasks.json`, then each write back their own version —
  whichever process's `writeFileSync` lands last wins, silently discarding the other task's
  appended files. The first planning pass (`runPlanner` over `TASKS`) still runs through
  `parallel` exactly as before — that phase only reads files, no task's plan run mutates
  `tasks.json`. Only the retry phase, which does mutate the shared file, is serialized: a
  plain indexed `for` loop over `TASKS`, `await`ing `retryWithFiles` before advancing to the
  next task, so no two calls to `addTaskFiles.ts` (or two `writeTaskBriefFile` calls) are ever
  in flight at once. A task that does not need a retry (`needsFileRetry(result)` false) costs
  nothing extra in the loop — its `firstPass[i]` result is pushed straight onto `plans` with
  no `await`.
- The trailing `return { plans, planned, needsClarification, notRelevant }` block is
  otherwise byte-for-byte identical to the original — it now buckets the post-retry `plans`
  array instead of the pre-retry one, which is the only behavior change intended there.

---

## Verification

Run all commands from the repo root: `/Users/matkatmusicllc/Programming/taskTools`.

### 1. Typecheck the new/changed TypeScript

```bash
npx tsc --noEmit
```
Expected: exits 0, no errors mentioning `scripts/addTaskFiles.ts`.

### 2. `plan.workflow.js` syntax and import resolution

```bash
bun build skills/tackle-tasks/plan.workflow.js --outdir /tmp/plan-workflow-build
```
Expected: exits 0, no error output — confirms the file still parses (top-level `import`/
`await` intact) and the three new import specifiers (`node:child_process`,
`../../scripts/taskFiles.ts`, `../../scripts/prepareTasks.ts`) resolve to real files.

### 3. `scripts/addTaskFiles.ts` behavior

```bash
node --test tests/addTaskFiles.test.ts
```
Expected: all 5 tests pass — order-preserving dedup, duplicate-incoming-path dedup,
multi-task-number append, unknown task number leaves `tasks.json` byte-for-byte unchanged,
and absolute/traversal paths are all rejected with `tasks.json` byte-for-byte unchanged.
Each test builds its own `mkdtempSync` fixture root under `.taskTools/tasks.json`, so this
never touches this repo's real `.taskTools/tasks.json`.

### 4. Full test suite still passes

```bash
node --test "tests/**/*.test.ts"
```
Expected: exits 0 — confirms `tests/addTaskFiles.test.ts` didn't break anything else and
that nothing already testing `plan.workflow.js`'s consumers regressed.

### 5. Two file-retry candidates in one run both keep their appended paths

`retryWithFiles` in edit 4d is not itself unit-tested (it drives a real planner agent, which
is out of scope for a script-level test), but the property the sequential loop exists to
protect — two tasks appending files to the same `tasks.json` in the same run must not clobber
each other — is exactly what `addTaskFiles.ts` does when invoked twice in a row for two
different tasks, so exercise it directly against the real CLI:

```bash
node --test tests/addTaskFiles.test.ts
```

This already includes the "a multi-task-number call appends the same paths to every named
task" case (asserts task 1 keeps `existing.ts` plus `shared.ts`, and task 2 independently gets
`shared.ts`), which is the single-process form of the same guarantee: one `addTaskFiles.ts`
process, one read, one write, no task's append lost. The reason the workflow-level fix (the
`for` loop replacing `parallel` in edit 4d) needs no separate integration test: it does not add
new logic to assert on, it removes concurrency so that each task's `retryWithFiles` call — and
therefore each task's `addTaskFiles.ts` invocation — runs alone, one at a time, which is
exactly the single-process condition `addTaskFiles.ts`'s own tests already cover in isolation.
