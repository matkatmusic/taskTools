# Task 137 plan — implement stage: worker agent, own tests, commit

## Scope

Only `skills/tackle-tasks/task.workflow.js` is edited. The other three owned
files need no edit:

- `plans/task-86-spec.md` — reference spec, not code; nothing in this task's
  goal list asks it to change.
- `skills/tackle-tasks/implement.workflow.js` — the chain goal says explicitly
  "Deleting `implement.workflow.js` and `test.workflow.js` is NOT part of this
  task — the old workflow files are removed at the end of the chain." That is
  the only planned change to this file, and it isn't this task's to make.
- `skills/tackle-tasks/test.workflow.js` — same reasoning; it disappears in a
  later task in the chain, not this one.

All edits below are to `skills/tackle-tasks/task.workflow.js` (277 lines as
currently read). Apply them in order; each is independent of live-file
re-checking since the quoted "current text" below was read directly from that
file.

## Edit 1 — add implement-stage ARGS constants

Current text (lines 1-3):

```
const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const N = ARGS.task
const STAGE = ARGS.stage ?? 'plan+implement'
```

Becomes:

```
const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const N = ARGS.task
const STAGE = ARGS.stage ?? 'plan+implement'
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
const WORKER_MODEL = ARGS.workerModel
const MAX_FIX_ROUNDS = ARGS.maxRounds ?? 3
```

Why: these three are the ARGS-derived settings `workerBrief` (added in Edit 3)
needs. They are moved across unchanged from `implement.workflow.js` lines
10-12 (`TYPECHECK_COMMAND`, `WORKER_MODEL`, `MAX_FIX_ROUNDS` — that file names
the same constant `ARGS.maxRounds ?? 3`). No name collides with an existing
`task.workflow.js` constant (`MAX_REVIEW_ROUNDS` is a different, unrelated
constant already in the file for the plan-review loop).

## Edit 2 — add WORKER_SCHEMA

Current text (lines 41-50, the end of `APPLY_FEEDBACK_SCHEMA` through the
start of `fileRetryPreamble`):

```
const APPLY_FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    applied: { type: 'boolean' },
  },
  required: ['task', 'applied'],
}

const fileRetryPreamble = (missingFiles) => `Before planning: the workflow has already widened this task's owned files in tasks.json to include ${missingFiles.join(', ')} and regenerated the brief file — you do not need to run any command for this. The owned-files list below already includes the paths you previously flagged as missing.
```

Becomes (inserting the new schema between the two, everything else unchanged):

```
const APPLY_FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    applied: { type: 'boolean' },
  },
  required: ['task', 'applied'],
}

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    remaining: { type: 'array', items: { type: 'string' } },
    notesFile: { type: 'string' },
  },
  required: ['task', 'status', 'summary', 'remaining', 'notesFile'],
}

const fileRetryPreamble = (missingFiles) => `Before planning: the workflow has already widened this task's owned files in tasks.json to include ${missingFiles.join(', ')} and regenerated the brief file — you do not need to run any command for this. The owned-files list below already includes the paths you previously flagged as missing.
```

Why: `WORKER_SCHEMA` is `implement.workflow.js`'s existing schema (its lines
14-23) plus the new `notesFile` field the chain goal requires ("`WORKER_SCHEMA`
gains a `notesFile` string"). `notesFile` is `required` because every return
branch of the new `workerBrief` (Edit 3) sets it — it is a deterministic path
the workflow computes, not something the agent might omit.

## Edit 3 — add `tddInstruction` and `workerBrief`, between `applyFeedbackBrief` and `retryAgent`

Current text (lines 153-156, the end of `applyFeedbackBrief` through the start
of `retryAgent`):

```
Return {task: ${t.number}, applied: true} once you have made the edits, or {task: ${t.number}, applied: false} if there was nothing to apply.`

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
```

Becomes:

```
Return {task: ${t.number}, applied: true} once you have made the edits, or {task: ${t.number}, applied: false} if there was nothing to apply.`

const tddInstruction = (t) => t.tests && t.tests !== 'skip'
  ? `This task's tests field holds an example test the user wrote: ${t.tests}\nWrite that test first, then expand it to also cover the individual functions/subparts you build, before writing the implementation.`
  : 'This task has no tests field, or it is the literal string "skip" — skip TDD entirely and just write the code.'

const workerBrief = (t, note) => `You are implementing EXACTLY ONE pre-planned task from
./.taskTools/tasks.json: #${t.number}.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

ownedFiles = ${t.files.join(', ')}
plan = ${t.planFile}
notesFile = ${t.notesFile}
timeBudget = 10 minutes
${note ? `note = ${note}\n` : ''}
${tddInstruction(t)}

use jot:implement ${t.planFile}, writing its implementation-notes log to exactly notesFile

if the plan is impossible as written:
    return {task: ${t.number}, status: "blocked", summary: why it cannot be done, remaining: [], notesFile: notesFile}

implement every step of the plan, editing only ownedFiles

typecheck = run(${TYPECHECK_COMMAND})
if typecheck reported errors in ownedFiles:
    fix them

if scripts/relatedTests.ts exists:
    tests = run it to discover the tests covering ownedFiles
else:
    tests = the test file belonging to each file in ownedFiles
// never run the full suite; that is the close-tasks gate, not yours

results = run(tests)
fixRound = 0
while any test failed and fixRound is less than ${MAX_FIX_ROUNDS}:
    fixRound = fixRound + 1
    fix the cause
    typecheck = run(${TYPECHECK_COMMAND})
    results = run(tests)

if any test still failed after ${MAX_FIX_ROUNDS} fix rounds:
    return {task: ${t.number}, status: "blocked", summary: what is still failing after ${MAX_FIX_ROUNDS} fix rounds, remaining: the failing test names, notesFile: notesFile}

if typecheck is clean and every test passed:
    run: ${t.files.length ? `git add -- ${[...t.files, t.notesFile].map((f) => JSON.stringify(f)).join(' ')}` : `git add -- ${JSON.stringify(t.notesFile)} (plus every other path you edited, listed explicitly)`}
    run: git commit -m "task ${t.number}: one-line summary"
    return {task: ${t.number}, status: "done", summary: one sentence, remaining: [], notesFile: notesFile}
else if part of the plan is implemented:
    return {task: ${t.number}, status: "partial", summary: one sentence, remaining: the plan steps not yet done, plus any failing test names, notesFile: notesFile}
else:
    return {task: ${t.number}, status: "blocked", summary: one sentence, remaining: the failing test names, notesFile: notesFile}

if you reach timeBudget before finishing:
    return status "partial" with the not-yet-done plan steps in remaining, notesFile still set to notesFile

You are forbidden to touch anything outside ownedFiles excluding notesFile; to
add scope or refactors the plan does not call for; to redecide anything the
plan already decided; to run the full suite, \`git add -A\`, or \`git add .\`; to
commit while anything fails; to attempt more than ${MAX_FIX_ROUNDS} fix
rounds; or to return status "done" with a failing test. Any test file created
or modified must be listed in ownedFiles; otherwise return status "blocked"
without editing it.`

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
```

Why every change from the old `implement.workflow.js` version of this brief
(lines 25-88 there) is made:

- `tddInstruction` is copied verbatim — no changes needed.
- `workerBrief` drops the `group` parameter and the `run(cd ${group.worktree})`
  step. `task.workflow.js` has no `group` concept: `loadPreparedTask` (already
  in the file) builds `repoRoot` from `process.cwd()` and uses it directly to
  locate `tasks.json`, the brief file, and the plan file with no `cd` step of
  its own — the whole workflow process already assumes it is launched with its
  working directory inside the task's worktree. The implement stage follows
  the same assumption, so the `cd` line is dropped rather than reinvented.
  `planFileFor(t.number)` also disappears — the old file looked the plan file
  up from a separate `APPROVED` array; here the plan file is already on `t`
  (`t.planFile`, set in `loadPreparedTask`/Edit 4) because plan and implement
  run in the same process on the same task object.
- `notesFile` is a new local computed on `t` (`t.notesFile`, from Edit 4), used
  in three places: told to the agent as a value to write jot:implement's notes
  to, included in every `return` branch (satisfying the new required schema
  field), and added to the `git add --` list alongside `t.files` so the notes
  file lands in the same commit as the owned files — `git add -A` / `git add .`
  remain forbidden by the closing paragraph, unchanged from the source file.
- The forbidden-actions paragraph drops the legacy "excluding the matching
  test files" carve-out from `implement.workflow.js`: tests are now owned and
  staged through `t.files` like every other file, so a test file the
  implementer needs to touch must already be in ownedFiles. In its place the
  paragraph keeps "excluding notesFile" (the one intentional out-of-ownedFiles
  write) and gains the sentence "Any test file created or modified must be
  listed in ownedFiles; otherwise return status \"blocked\" without editing
  it," which replaces the removed carve-out.
- `runWorker`, the `implementGroup` per-group loop, and `requeueCount` are not
  copied here — Edit 5 replaces them with a single-task, single-or-twice-run
  call (see Edit 5's rationale for why the loop over `tasks` disappears while
  the one partial-requeue retry stays).

## Edit 4 — add `notesFile` to the object `loadPreparedTask` returns

Current text (lines 168-185):

```
const loadPreparedTask = async () => {
  const { resolveTaskFiles, readTaskFile } = await import('./scripts/taskFiles.ts')
  const { writeTaskBriefFile } = await import('./scripts/prepareTasks.ts')
  const repoRoot = process.cwd()
  const pair = resolveTaskFiles(repoRoot)
  const task = readTaskFile(pair.tasksPath).find((entry) => entry.taskNumber === N)
  if (!task) throw new Error(`task.workflow.js: task ${N} not found in tasks.json`)
  const briefFile = writeTaskBriefFile(task, repoRoot)
  return {
    number: N,
    briefFile,
    planFile: `${repoRoot}/plans/task-${N}-plan.md`,
    files: Array.isArray(task.files) ? task.files : [],
    tests: task.tests,
    repoRoot,
    pair,
  }
}
```

Becomes:

```
const loadPreparedTask = async () => {
  const { resolveTaskFiles, readTaskFile } = await import('./scripts/taskFiles.ts')
  const { writeTaskBriefFile } = await import('./scripts/prepareTasks.ts')
  const repoRoot = process.cwd()
  const pair = resolveTaskFiles(repoRoot)
  const task = readTaskFile(pair.tasksPath).find((entry) => entry.taskNumber === N)
  if (!task) throw new Error(`task.workflow.js: task ${N} not found in tasks.json`)
  const briefFile = writeTaskBriefFile(task, repoRoot)
  return {
    number: N,
    briefFile,
    planFile: `${repoRoot}/plans/task-${N}-plan.md`,
    notesFile: `${repoRoot}/plans/task-${N}-implementation-notes.md`,
    files: Array.isArray(task.files) ? task.files : [],
    tests: task.tests,
    repoRoot,
    pair,
  }
}
```

Why: this is the one deterministic place the notes-file path is computed,
mirroring how `planFile` is computed one line above it — same `repoRoot`,
same `plans/task-<N>-...` shape, per the chain goal's required path
`plans/task-<N>-implementation-notes.md`. Because `preparedTask` is a single
object shared across `runPlan` and `runImplement` in the same process (already
true of the file today), the implement stage reads this from the same live
object the plan stage populated/widened — this is what satisfies the "implement
stage reads the task's LIVE files list from the same process that ran the plan
stage" requirement; no other change is needed for that requirement since
`preparedTask.files` is already read by `runImplement`, and `runPlan`'s
`widenFilesAndReplan` already mutates `preparedTask.files` in place (existing
code, lines 217, unchanged).

## Edit 5 — replace the stub `runImplement` with the real implement stage

Current text (lines 246-250):

```
const runImplement = async () => {
  log(`task ${N}: implement stage (stub)`)
  if (!preparedTask) preparedTask = await loadPreparedTask()
  return { stage: 'implement', task: N, files: preparedTask.files }
}
```

Becomes:

```
const runWorker = (t, note) => {
  const options = {
    label: `implement:${t.number}`,
    phase: `${t.number} Implement`,
    schema: WORKER_SCHEMA,
  }
  if (WORKER_MODEL) options.model = WORKER_MODEL
  return retryAgent(() => agent(workerBrief(t, note), options))
}

const runImplement = async () => {
  log(`task ${N}: implement stage`)
  if (!preparedTask) preparedTask = await loadPreparedTask()
  let result = await runWorker(preparedTask, '') ?? {
    task: N,
    status: 'blocked',
    summary: 'worker agent returned no result after 3 attempts (killed, errored, or blocked)',
    remaining: [],
    notesFile: preparedTask.notesFile,
  }
  if (result.status === 'partial') {
    const note = `A previous worker finished part of this plan; still remaining: ${result.remaining.join('; ')}. Check the file state before redoing anything.`
    result = (await runWorker(preparedTask, note)) ?? result
  }
  return { stage: 'implement', ...result, files: preparedTask.files }
}
```

Why: `runWorker` is `implement.workflow.js`'s existing helper (its lines
101-105) with the `group` argument removed for the same reason as `workerBrief`
in Edit 3 — no per-task worktree concept to plumb through. `retryAgent` is not
redeclared: `task.workflow.js` already defines an identical `retryAgent` at
lines 156-162 (the plan stage's file already has this exact function), so
`runWorker` calls the one already in scope rather than duplicating it.

The old `implementGroup` (`implement.workflow.js` lines 109-119) looped
`for (const t of tasks)` because one worker had to serially run through every
task sharing a group's worktree. `task.workflow.js` runs one task per process
(`N` is the sole task this file ever handles), so that loop has no tasks left
to iterate over — this is what "the serial-workers-within-one-task machinery is
gone" means, and it is satisfied by there being no loop at all here, not by a
loop of length one.

The one-shot partial-requeue behavior (`implement.workflow.js` lines 122-128:
on `status === 'partial'`, run the worker again once with a note describing
what's left, keeping the redone result whether or not it's an improvement) is
kept, adapted to a single task instead of `results.filter(...)`/array
bookkeeping: `result.status === 'partial'` triggers exactly one more
`runWorker` call with the same note wording, and its outcome (or the original
`result` if the retry itself returned nothing) becomes the final `result`.
`requeueCount` is dropped — it was a per-group tally across many tasks'
outcomes; with one task per process there is nothing left to tally, and
nothing in the chain goal asks for it to survive.

The final return shape mirrors `runPlan`'s pattern one function above it
(`{ stage: 'plan', ...result }`): `{ stage: 'implement', ...result, files:
preparedTask.files }` puts `stage` first, spreads every `WORKER_SCHEMA` field
(`task`, `status`, `summary`, `remaining`, `notesFile`) from whichever
`runWorker` call produced the returned `result`, and keeps `files` at the end
exactly as the stub already returned it.

## Verification

Run these from the repo root (`/Users/matkatmusicllc/Programming/taskTools-86`)
after applying all five edits:

1. `node --check skills/tackle-tasks/task.workflow.js`
   Expected: no output, exit code 0. (This only parses the file; `agent`,
   `log`, `parallel`, and `args` are workflow-runtime globals this file
   depends on, so the script cannot be executed directly with plain `node` —
   syntax validity is what this checks.)

2. `rg -n "notesFile" skills/tackle-tasks/task.workflow.js`
   Expected: at least these matches — inside `WORKER_SCHEMA`'s `properties`
   and `required`, inside `loadPreparedTask`'s returned object, inside
   `workerBrief`'s body (multiple), and inside `runImplement`'s fallback
   object.

3. `rg -n "stub" skills/tackle-tasks/task.workflow.js`
   Expected: two matches only — `runRebaseTest` and `runMerge`'s `log(...
   (stub))` lines, which this task does not touch. `runImplement`'s `(stub)`
   text must no longer appear.

4. `rg -n "group\.worktree|planFileFor|implementGroup|requeueCount" skills/tackle-tasks/task.workflow.js`
   Expected: no output — none of `implement.workflow.js`'s group-based
   machinery was copied across.

5. `git diff --stat -- skills/tackle-tasks/implement.workflow.js skills/tackle-tasks/test.workflow.js plans/task-86-spec.md`
   Expected: no output — these three owned files are untouched.

6. `git diff --stat -- skills/tackle-tasks/task.workflow.js`
   Expected: one line showing `task.workflow.js` changed, insertions only
   (no deletions besides the two stub lines replaced in Edit 5).
