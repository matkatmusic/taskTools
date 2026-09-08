# Task 136 plan: tackle-tasks: programmatic missing-file widening and planner re-run

## Summary

`runPlan()` in `skills/tackle-tasks/task.workflow.js` runs an initial planner
agent, then loops up to `MAX_REVIEW_ROUNDS` (3) times: verify, and if not
approved, fix, re-verify. Today the "fix" step always calls
`applyFeedbackBrief`, even when the verifier returned a non-empty
`missingFiles` array — but `applyFeedbackBrief` explicitly does nothing in
that case ("If the text above has no FIXES section to apply (for example a
MISSING_FILES section instead), make no edits and return applied false."),
so a missing-file rejection just burns rounds with no progress. The existing
`fileRetryPreamble` helper (lines 50-60) is defined but never passed to
`plannerBrief` anywhere in the file — it is dead code today.

This task makes the workflow branch on `verify.missingFiles`: when non-empty,
plain code (no agent) runs `scripts/addTaskFiles.ts` to widen the task's
owned files in `tasks.json`, regenerates the brief, and re-invokes the
planner agent from scratch with `fileRetryPreamble` as the preamble — reusing
the same round-counter loop from task 135 so the widen-and-replan cycle
consumes one of the three rounds.

Because the widening is now performed by plain code before the planner is
re-invoked, the planner agent itself no longer needs to run any command or
touch `tasks.json`/the brief — `fileRetryPreamble` and `plannerBrief` are
simplified to stop offering that permission. And because "the widened files
list is the same list the implement stage later uses" requires one process
to hold one live list, the task/prepared-task state is hoisted from a
`runPlan()`-local `const` to a module-scope `let preparedTask`, populated by
a shared `loadPreparedTask()` helper that both `runPlan()` and
`runImplement()` call.

## Files

### skills/tackle-tasks/task.workflow.js — edits required

**Edit 1 — simplify `fileRetryPreamble`: the workflow now widens files and regenerates the brief itself, so the preamble no longer hands the agent Bash commands to do it.**

Current text (lines 50-60):
```
const fileRetryPreamble = (t, missingFiles) => `Before planning, run these two commands with Bash from ${ARGS.repo} to gain read access to the files you flagged as missing, then continue below:

1. cd ${ARGS.repo} && node "scripts/addTaskFiles.ts" '[${t.number}]' ${missingFiles.map((f) => JSON.stringify(f)).join(' ')}
2. cd ${ARGS.repo} && node -e "(async()=>{const {resolveTaskFiles,readTaskFile}=await import('./scripts/taskFiles.ts');const {writeTaskBriefFile}=await import('./scripts/prepareTasks.ts');const pair=resolveTaskFiles(process.cwd());const task=readTaskFile(pair.tasksPath).find(x=>x.taskNumber===${t.number});if(!task)throw new Error('task ${t.number} disappeared from tasks.json');writeTaskBriefFile(task,process.cwd());console.log(JSON.stringify(task.files));})()"

Command 1 adds the missing paths to this task's owned files in tasks.json.
Command 2 regenerates plans/brief-${t.number}.md from the updated task record and prints
the task's full current owned-files list as a JSON array on stdout — record that array,
you will return it as "files" below.

`
```

Becomes:
```
const fileRetryPreamble = (missingFiles) => `Before planning: the workflow has already widened this task's owned files in tasks.json to include ${missingFiles.join(', ')} and regenerated the brief file — you do not need to run any command for this. The owned-files list below already includes the paths you previously flagged as missing.

`
```

**Edit 2 — simplify `plannerBrief`'s return/forbidden-actions lines: the agent no longer reports back a `files` array or gets permission to edit `tasks.json`/the brief, since it never performs those mutations itself.**

Current text (lines 94-98):
```
Return {task: ${t.number}, status, planFile: "${t.planFile}", question, missingFiles}.
${preamble ? `Also return "files": the JSON array command 2 above printed.\n` : ''}
You are forbidden to edit any file other than ${t.planFile}${preamble ? ', tasks.json, and plans/brief-*.md — those only via the two commands given above' : ''}; to read a file outside
the owned list; to leave a decision for the implementer; or to write a plan step
whose exact target you did not read.`
```

Becomes:
```
Return {task: ${t.number}, status, planFile: "${t.planFile}", question, missingFiles}.
You are forbidden to edit any file other than ${t.planFile}; to read a file outside
the owned list; to leave a decision for the implementer; or to write a plan step
whose exact target you did not read.`
```

(`plannerBrief`'s `preamble` parameter and its first line, `${preamble}Invoke /ponytail:ponytail ultra.`, are unchanged — the preamble is still prepended as plain text, it just no longer grants extra edit permissions or asks for a `files` return value.)

**Edit 3 — hoist the prepared-task state to module scope via a shared `loadPreparedTask()` helper, and rewrite `runPlan`/`runImplement` to use it, so both stages read the same live files list.**

Current text (lines 173-218):
```
const MAX_REVIEW_ROUNDS = 3

const runPlan = async () => {
  log(`task ${N}: plan stage`)
  const { resolveTaskFiles, readTaskFile } = await import('./scripts/taskFiles.ts')
  const { writeTaskBriefFile } = await import('./scripts/prepareTasks.ts')
  const repoRoot = process.cwd()
  const pair = resolveTaskFiles(repoRoot)
  const task = readTaskFile(pair.tasksPath).find((entry) => entry.taskNumber === N)
  if (!task) throw new Error(`task.workflow.js: task ${N} not found in tasks.json`)
  const briefFile = writeTaskBriefFile(task, repoRoot)
  const preparedTask = {
    number: N,
    briefFile,
    planFile: `${repoRoot}/plans/task-${N}-plan.md`,
    files: Array.isArray(task.files) ? task.files : [],
    tests: task.tests,
  }
  const result = await retryAgent(() => agent(plannerBrief(preparedTask), { label: `plan:${N}`, phase: 'Plan', schema: PLAN_SCHEMA }))
  const planResult = {
    stage: 'plan',
    ...(result ?? {
      task: N,
      status: 'needs-clarification',
      planFile: '',
      question: 'planner returned no result after 3 attempts',
    }),
  }
  if (planResult.status !== 'planned') return planResult
  const runVerify = async () => await retryAgent(() => agent(verifierBrief(preparedTask, preparedTask.planFile), { label: `verify:${N}`, phase: 'Plan', schema: VERIFY_SCHEMA })) ?? {
    task: N,
    verdict: 'rejected',
    notes: 'verifier agent returned no result after 3 attempts (killed, errored, or blocked)',
    reviewer: 'none',
    missingFiles: [],
  }
  let reviewRounds = MAX_REVIEW_ROUNDS
  let verify = await runVerify()
  reviewRounds -= 1
  while (verify.verdict !== 'approved' && reviewRounds > 0) {
    await retryAgent(() => agent(applyFeedbackBrief(preparedTask, preparedTask.planFile, verify.notes), { label: `applyFeedback:${N}`, phase: 'Plan', schema: APPLY_FEEDBACK_SCHEMA }))
    verify = await runVerify()
    reviewRounds -= 1
  }
  return { ...planResult, verify, reviewRounds }
}
```

Becomes:
```
const MAX_REVIEW_ROUNDS = 3

let preparedTask = null

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

const runPlan = async () => {
  log(`task ${N}: plan stage`)
  preparedTask = await loadPreparedTask()
  const { execFileSync } = await import('node:child_process')
  const { readTaskFile } = await import('./scripts/taskFiles.ts')
  const { writeTaskBriefFile } = await import('./scripts/prepareTasks.ts')
  const result = await retryAgent(() => agent(plannerBrief(preparedTask), { label: `plan:${N}`, phase: 'Plan', schema: PLAN_SCHEMA }))
  let planResult = {
    stage: 'plan',
    ...(result ?? {
      task: N,
      status: 'needs-clarification',
      planFile: '',
      question: 'planner returned no result after 3 attempts',
    }),
  }
  planResult.files = preparedTask.files
  if (planResult.status !== 'planned') return planResult
  const runVerify = async () => await retryAgent(() => agent(verifierBrief(preparedTask, preparedTask.planFile), { label: `verify:${N}`, phase: 'Plan', schema: VERIFY_SCHEMA })) ?? {
    task: N,
    verdict: 'rejected',
    notes: 'verifier agent returned no result after 3 attempts (killed, errored, or blocked)',
    reviewer: 'none',
    missingFiles: [],
  }
  const widenFilesAndReplan = async (missingFiles) => {
    execFileSync('node', ['scripts/addTaskFiles.ts', JSON.stringify([N]), ...missingFiles], { cwd: preparedTask.repoRoot })
    const widenedTask = readTaskFile(preparedTask.pair.tasksPath).find((entry) => entry.taskNumber === N)
    if (!widenedTask) throw new Error(`task.workflow.js: task ${N} disappeared from tasks.json`)
    writeTaskBriefFile(widenedTask, preparedTask.repoRoot)
    preparedTask.files = Array.isArray(widenedTask.files) ? widenedTask.files : []
    const rePlanned = await retryAgent(() => agent(plannerBrief(preparedTask, fileRetryPreamble(missingFiles)), { label: `plan:${N}`, phase: 'Plan', schema: PLAN_SCHEMA }))
    planResult = {
      stage: 'plan',
      ...(rePlanned ?? {
        task: N,
        status: 'needs-clarification',
        planFile: '',
        question: 'planner returned no result after 3 attempts',
      }),
    }
    planResult.files = preparedTask.files
  }
  let reviewRounds = MAX_REVIEW_ROUNDS
  let verify = await runVerify()
  reviewRounds -= 1
  while (verify.verdict !== 'approved' && reviewRounds > 0) {
    if (Array.isArray(verify.missingFiles) && verify.missingFiles.length > 0) {
      await widenFilesAndReplan(verify.missingFiles)
      if (planResult.status !== 'planned') return planResult
    } else {
      await retryAgent(() => agent(applyFeedbackBrief(preparedTask, preparedTask.planFile, verify.notes), { label: `applyFeedback:${N}`, phase: 'Plan', schema: APPLY_FEEDBACK_SCHEMA }))
    }
    verify = await runVerify()
    reviewRounds -= 1
  }
  return { ...planResult, verify, reviewRounds }
}
```

**Edit 4 — `runImplement` becomes async and explicitly consumes the shared files list, loading it itself when the workflow starts directly at the `implement` stage (so `runPlan()` never ran in this process).**

Current text (lines 220-223):
```
const runImplement = () => {
  log(`task ${N}: implement stage (stub)`)
  return { stage: 'implement', task: N }
}
```

Becomes:
```
const runImplement = async () => {
  log(`task ${N}: implement stage (stub)`)
  if (!preparedTask) preparedTask = await loadPreparedTask()
  return { stage: 'implement', task: N, files: preparedTask.files }
}
```

**Edit 5 — `STAGE_RUNNERS` must `await` the now-async `runImplement`.**

Current text (lines 235-245):
```
const STAGE_RUNNERS = {
  plan: async () => [await runPlan()],
  implement: () => [runImplement()],
  'rebase-test': () => [runRebaseTest()],
  merge: () => [runMerge()],
  'plan+implement': async () => {
    const planResult = await runPlan()
    if (planResult.status !== 'planned') return [planResult]
    return [planResult, runImplement()]
  },
}
```

Becomes:
```
const STAGE_RUNNERS = {
  plan: async () => [await runPlan()],
  implement: async () => [await runImplement()],
  'rebase-test': () => [runRebaseTest()],
  merge: () => [runMerge()],
  'plan+implement': async () => {
    const planResult = await runPlan()
    if (planResult.status !== 'planned') return [planResult]
    return [planResult, await runImplement()]
  },
}
```

Notes on the design decisions baked into these edits (all settled, none left open):

- The agent no longer performs the widening: `fileRetryPreamble` and
  `plannerBrief` are simplified so the re-planning agent is told the files
  were already widened and the brief already regenerated, and is given no
  Bash commands and no permission to edit `tasks.json` or the brief. This
  satisfies "the workflow itself — plain code, not an agent — runs
  `node scripts/addTaskFiles.ts`" without leaving a dead second code path
  where the agent could also attempt it.
- `execFileSync('node', ['scripts/addTaskFiles.ts', JSON.stringify([N]), ...missingFiles], { cwd: preparedTask.repoRoot })`
  is the plain-code equivalent of the exact command previously only given to
  agents: `node "scripts/addTaskFiles.ts" '[${t.number}]' <paths>`. It is
  spawned as an argv array (not a shell string), which needs no per-path
  `JSON.stringify` escaping the way a shell-command string would — there is
  no shell parsing an argv array, so passing each path as a plain array
  element is correct and simpler. `addTaskFiles.ts` already enforces the
  repo-relative path boundary (`rejectionReason`) and appends without
  duplicates (`appendFiles`) — a non-zero exit from a rejected path throws
  from `execFileSync` by default, which is correct: the workflow does not
  re-validate paths itself, per the brief's explicit instruction.
- `preparedTask` is hoisted to module scope (`let preparedTask = null`,
  declared once, before `runPlan`) instead of being a `runPlan()`-local
  `const`, and both `runPlan()` and `runImplement()` read and write that one
  object. This is what makes "the widened files list is the same list the
  implement stage later uses, because one process handles the whole task"
  literally true: `runPlan()` mutates `preparedTask.files` in place during
  `widenFilesAndReplan`, and when `STAGE_RUNNERS['plan+implement']` calls
  `runImplement()` afterward in the same process, it reads that same
  already-mutated object — not a fresh re-read, not a frozen snapshot taken
  at launch.
- `loadPreparedTask()` is a small shared helper (not duplicated logic)
  because `runImplement()` also needs the prepared-task shape when the
  workflow is launched directly at the `implement` stage — i.e. in a
  process where `runPlan()` never ran and `preparedTask` is still `null`.
  In that case `runImplement()` calls `loadPreparedTask()` itself, which
  reads the task fresh from `tasks.json` — correct, because any earlier
  widening from a prior `plan`-stage process was already durably persisted
  there by `execFileSync`.
- `preparedTask.repoRoot` and `preparedTask.pair` are carried on the shared
  object (not just `files`/`briefFile`/`planFile`/`tests`/`number`) because
  `widenFilesAndReplan` needs the repo root and the resolved `tasksPath` to
  re-run `addTaskFiles.ts` and re-read `tasks.json`, and only one shared
  object exists now — there is no separate `runPlan()`-local `repoRoot`
  to close over instead. The extra fields are harmless to `plannerBrief`,
  `verifierBrief`, and `applyFeedbackBrief`, which only read the specific
  properties they already used (`briefFile`, `files`, `planFile`, `number`,
  `tests`).
- `planResult.files = preparedTask.files` (both on the initial plan result
  and again inside `widenFilesAndReplan`) makes the returned `files` field
  authoritative from the workflow's own live list, rather than trusting
  whatever the agent happened to echo back. The prior draft's
  `if (Array.isArray(planResult.files)) preparedTask.files = planResult.files`
  ran backwards — letting agent output overwrite workflow state — and is
  removed entirely; `plannerBrief` no longer even asks the agent to return
  a `files` field (Edit 2), so there is nothing on `result`/`rePlanned` to
  read here regardless.
- `plannerBrief(preparedTask, fileRetryPreamble(missingFiles))` is "the
  planner re-run from scratch": it is a full new call to the planner agent
  with `PLAN_SCHEMA`, which per `plannerBrief`'s own text always instructs
  the agent to write the whole plan file fresh ("write the plan to exactly
  this path: ${t.planFile}") — never an incremental patch the way
  `applyFeedbackBrief` performs one. This satisfies "a fresh plan, not an
  amendment of the old one." `fileRetryPreamble` no longer takes a `t`
  parameter (Edit 1) since it no longer needs `t.number` or `ARGS.repo` for
  Bash commands — only the `missingFiles` list, to name what was widened.
- The branch is decided by
  `Array.isArray(verify.missingFiles) && verify.missingFiles.length > 0`
  rather than trusting the field to always be an array: `VERIFY_SCHEMA`
  does not list `missingFiles` in `required`, so an approved-shaped or
  malformed verify result could omit it; this is ordinary defensive coding
  against the file's own declared schema, not a left-open decision.
- Consuming one of the three rounds: both branches of the `if`
  (widen-and-replan, or the pre-existing `applyFeedbackBrief` call) fall
  through to the same `verify = await runVerify(); reviewRounds -= 1` at the
  bottom of the loop body, unchanged from before. This is exactly what
  "consumes one of the three rounds from task 135" means — the
  widen-and-replan path decrements the identical `reviewRounds` counter the
  `applyFeedback` path already used, because it is the same loop iteration.
- `if (planResult.status !== 'planned') return planResult` after the
  widen-and-replan call mirrors the identical early-return already present
  right after the very first planner call: if the re-run planner cannot
  produce a usable plan even with the widened files (e.g. it comes back
  `needs-clarification` or `not-relevant`), the plan stage ends immediately
  with that result, the same way the first planning attempt would have.
- `runImplement` and the `implement`/`plan+implement` entries in
  `STAGE_RUNNERS` become `async`/`await`-wrapped because `runImplement` now
  does an `await loadPreparedTask()` in the standalone-`implement`-stage
  case. Every call site of `runImplement()` is updated in the same edit
  (Edit 5) so no caller is left awaiting a bare function reference or a
  still-pending promise inside a results array.
- `PLAN_SCHEMA` is left unchanged — its optional `files` property (not in
  `required`) simply goes unused now that `plannerBrief` no longer asks the
  agent to populate it; leaving an unused optional schema property causes
  no behavior change and isn't part of the reviewer's requested fixes.

### scripts/addTaskFiles.ts — no edit

No changes to this file. Its existing CLI entry point (`runAsCli`, invoked
via the `import.meta.url === file://${process.argv[1]}` guard) already
accepts exactly `'[N]' <path> <path> ...` as `process.argv.slice(2)`, parses
the leading task-number array with `leadingTaskNumbers`, treats the
remainder as paths, rejects anything outside the repo boundary
(`rejectionReason`), and appends new paths without duplicating existing ones
(`appendFiles`) before writing `tasks.json` back out. This is precisely the
interface `execFileSync('node', ['scripts/addTaskFiles.ts', ...])` needs —
the brief says to change this file "only if the widening call needs an
interface it does not already have," and it does not.

## Verification

Run from the repo root (`/Users/matkatmusicllc/Programming/taskTools-86`):

1. Syntax check the edited file. `task.workflow.js` is not a normal Node
   module — it uses `export const meta` (module syntax) together with a
   top-level `return` (script-inside-a-function syntax), which only parses
   once the harness strips the `export` and wraps the body in a function.
   Reproduce that shim to confirm the edit introduces no syntax error:

```
node -e '
const fs = require("fs");
let src = fs.readFileSync("skills/tackle-tasks/task.workflow.js", "utf8");
src = src.replace("export const meta", "const meta");
new Function("args", "agent", "log", "return (async () => {\n" + src + "\n})()");
console.log("syntax OK");
'
```

Expected: prints `syntax OK` and exits 0. (This only compiles the function
body — `args`/`agent`/`log` are declared as parameters and never invoked, so
no real agent or file I/O runs.)

2. Confirm the new wiring is present at the right places:

```
rg -n "let preparedTask|loadPreparedTask|widenFilesAndReplan|execFileSync|verify.missingFiles|fileRetryPreamble\(missingFiles\)" skills/tackle-tasks/task.workflow.js
```

Expected: matches for the module-scope `let preparedTask = null`, the
`loadPreparedTask` helper definition, the `widenFilesAndReplan` helper
definition, its `if (Array.isArray(verify.missingFiles) ...)` call site
inside the `while` loop, the `execFileSync(...)` line, and the
`fileRetryPreamble(missingFiles)` call inside the helper.

3. Confirm the agent-facing prompts no longer offer the old Bash-based
   widening path or the old `files`-return/edit-permission language:

```
rg -n "Before planning, run these two commands|command 2 above|tasks.json, and plans/brief" skills/tackle-tasks/task.workflow.js
```

Expected: no output (empty — all three phrases are gone).

4. Confirm `runImplement` and `STAGE_RUNNERS` consume the shared list:

```
rg -n "if \(!preparedTask\) preparedTask = await loadPreparedTask\(\)|implement: async \(\) => \[await runImplement\(\)\]|await runImplement\(\)" skills/tackle-tasks/task.workflow.js
```

Expected: matches inside `runImplement`, the `implement` entry of
`STAGE_RUNNERS`, and the `plan+implement` entry of `STAGE_RUNNERS`.

5. Confirm `scripts/addTaskFiles.ts` is untouched:

```
git diff --stat scripts/addTaskFiles.ts
```

Expected: no output (empty diff).

6. Review the full diff's scope: it should only touch `fileRetryPreamble`,
   `plannerBrief`'s return/forbidden-actions lines, the new
   `preparedTask`/`loadPreparedTask` module-scope declarations, `runPlan`,
   `runImplement`, and `STAGE_RUNNERS`:

```
git diff skills/tackle-tasks/task.workflow.js
```

Expected: hunks only in those locations; no changes to `meta`, `PLAN_SCHEMA`,
`VERIFY_SCHEMA`, `APPLY_FEEDBACK_SCHEMA`, `testsInstruction`, `codexPrompt`,
`verifierBrief`, `applyFeedbackBrief`, `retryAgent`, `MAX_REVIEW_ROUNDS`,
`runRebaseTest`, or `runMerge`.
