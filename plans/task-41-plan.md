# Task 41 Plan: add Verify and Test phases to tackle-tasks workflow

## Why (one paragraph, not per-line — see rationale notes inline below for per-line "why")

The workflow currently goes Plan → Implement → Typecheck → Merge. This adds
Verify right after Plan (an agent that reads the plan and decides if it's
good enough to implement — bad plans never reach a worker) and Test right
after Implement (an agent that runs the tests touched by what just got
committed, and feeds failures back into the same worker via the existing
requeue pattern). The file is at the 250-line cap already, so step 1 is a
pure extraction (no behavior change) and step 2 is the additive change.

## Order of operations

1. Create `skills/tackle-tasks/tackle-tasks.briefs.js` first (step 2 imports from it).
2. Rewrite `skills/tackle-tasks/tackle-tasks.workflow.js` to import from it and add the two phases.
3. Verify (see Verification section).

Do not touch `scripts/relatedTests.ts` or `scripts/testPolicy.ts` — the Test
agent's brief just points at the existing discovery pattern in prose, same
as the existing worker brief already does for its own test step.

---

## Step 1 — create `skills/tackle-tasks/tackle-tasks.briefs.js`

New file. Exports the schemas and prompt-builder functions the brief names:
`VERIFY_SCHEMA`, `TEST_SCHEMA`, `verifierBrief`, `testerBrief`, plus
`plannerBrief` and `workerBrief` moved out of the workflow file unchanged
in *behavior* (one signature change, see the callout below).

```js
export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    notes: { type: 'string' },
  },
  required: ['task', 'verdict', 'notes'],
}

export const TEST_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task: { type: 'integer' }, detail: { type: 'string' } },
        required: ['task', 'detail'],
      },
    },
  },
  required: ['passed', 'failures'],
}

export const plannerBrief = (t) => `Invoke /ponytail:ponytail ultra.
Read ONLY this brief file (do not read any other file): ${t.briefFile}
Follow ~/.claude/guides/planning.md and write the plan to exactly this path: ${t.planFile}
Do not change any source file — this is planning only, not implementation.
If the task is unclear, set status "needs-clarification" and put your
question in "question". If the task no longer applies to the codebase, set
status "not-relevant" and explain why in "question". Otherwise write the
plan file and set status "planned".
Return {task: ${t.number}, status, planFile: "${t.planFile}", question}.`

export const verifierBrief = (t, planFile) => `Read ONLY these two files: the
brief ${t.briefFile} and the plan ${planFile}. Do not read any other file, do
not run any command, do not change anything — this is a plan review, not an
implementation step.

Check whether the plan is good enough to hand to an implementer: it stays
within the task's owned files (${t.files.join(', ')}), it gives concrete
steps rather than open design questions, and someone could follow it without
having to decide anything the plan should have already decided.

If it holds up, verdict "approved". If it's vague, out of scope, or would
leave the implementer guessing, verdict "rejected" and say exactly why in
notes — that reason is the only thing anyone will see before the task is
skipped.
Return {task: ${t.number}, verdict, notes}.`

export const workerBrief = (t, group, planFile, note, typecheckCommand) => `You are implementing EXACTLY ONE pre-planned task: #${t.number}.
Repo root (cd here first): ${group.worktree}
Plan file: ${planFile}
Files you own (touch nothing outside them): ${t.files.join(', ')}
${note}
Read the plan file, then implement it exactly — no scope additions, no
refactors the plan doesn't call for. All design decisions were made in the
plan; you are executing, not deciding. If the plan is impossible as written,
stop and return status "blocked" with the reason in summary.

When the edits are done, run: ${typecheckCommand}
Fix type errors in the files you own.

Then run the tests covering the files you own and fix any failures — check
for a related-test discovery command in this repo (e.g. scripts/relatedTests.ts)
before falling back to running each owned file's own test file directly. Do
not run the full suite; that is the close-tasks gate, not yours.

If your tests still fail after a reasonable effort, do not commit. Return
status "blocked" (or "partial" if part of the plan is done) and name the
failing tests in "remaining" — never return status "done" with a failing test.

When typecheck passes, commit from ${group.worktree}. Other tasks may share
this worktree, so stage ONLY your own paths — never \`git add -A\`, never \`git add .\`:
  ${t.files.length ? `git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}` : 'git add -- <list every path you edited, explicitly>'}
  git commit -m "task ${t.number}: <one-line summary>"

Soft time budget: 10 minutes — if you cannot finish, stop and return status
"partial" with the not-yet-done plan steps listed in "remaining".
Return {task: ${t.number}, status, summary (one sentence), remaining}.`

export const testerBrief = (group, doneTasks) => `cd ${group.worktree}.
The following tasks just committed changes to these files:
${doneTasks.map((t) => `- task ${t.number}: ${t.files.join(', ')}`).join('\n')}

Report only — do not edit any file. Find and run the tests covering these
files: check for a related-test discovery command in this repo (e.g.
scripts/relatedTests.ts) before falling back to running each file's own test
file directly. Do not run the full suite.

Return passed=true only if every discovered test passes. Otherwise
passed=false and, for each task whose files have a failing test, add an
entry to failures: {task: <task number>, detail: <failing test names and a
short error summary>}.
Return {passed, failures}.`
```

**Callout — why `workerBrief` gained a 5th parameter:** the original
`workerBrief` closed over the module-level `TYPECHECK_COMMAND` const. Once
it moves to a separate module it can't see that const anymore, so it must
take `typecheckCommand` as an explicit argument. The call site in the
workflow file passes `TYPECHECK_COMMAND` in (see Step 2). This is the only
signature change in the move — `plannerBrief` and `testerBrief` don't close
over anything outside their own parameters, so they move verbatim.

`PLAN_SCHEMA`, `WORKER_SCHEMA`, `TYPECHECK_SCHEMA`, and `MERGE_SCHEMA` are
**not** moved — the brief only names `VERIFY_SCHEMA`/`TEST_SCHEMA` for
relocation, and those two are the ones paired with the brief-builder
functions that are moving. Leave the other four where they are.

**Callout — how `import` reaches the workflow runner:** the brief's own
`### skills/tackle-tasks/tackle-tasks.workflow.js` reference block already
shows `export const meta = {...}` at the top of that file, so the runner
already loads it as an ES module. Before adding the `import` line, check
whether any other `*.workflow.js` file in this repo already imports a
sibling module (grep for `.workflow.js` files or an existing multi-file
skill) and mirror that syntax exactly. If no sibling example exists, use a
plain top-of-file `import { ... } from './tackle-tasks.briefs.js'` — do not
guess at a non-standard loader mechanism without checking first.

---

## Step 2 — rewrite `skills/tackle-tasks/tackle-tasks.workflow.js`

Full target contents:

```js
import { plannerBrief, verifierBrief, workerBrief, testerBrief, VERIFY_SCHEMA, TEST_SCHEMA } from './tackle-tasks.briefs.js'

export const meta = {
  name: 'tackle-tasks-pipeline',
  description: 'Plan, verify, implement, test, and typecheck file-disjoint task groups as an overlapping pipeline, then merge each group back into the repo',
  phases: [
    { title: 'Plan', detail: 'one planner agent per task' },
    { title: 'Verify', detail: 'one verifier agent per planned task, gates which plans reach Implement' },
    { title: 'Implement', detail: 'serial workers per group, one-pass requeue for partial' },
    { title: 'Test', detail: 'one test agent per group after Implement, one-pass requeue on failure' },
    { title: 'Typecheck', detail: 'report-only agent per worktree' },
    { title: 'Merge', detail: 'merge each group branch back into the repo' },
  ],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const REPO = ARGS.repo
const GROUPS = ARGS.groups ?? []
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
const PLAN_MODEL = ARGS.planModel
const WORKER_MODEL = ARGS.workerModel

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

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    remaining: { type: 'array', items: { type: 'string' } },
  },
  required: ['task', 'status', 'summary', 'remaining'],
}

const TYPECHECK_SCHEMA = {
  type: 'object',
  properties: { passed: { type: 'boolean' }, notes: { type: 'string' } },
  required: ['passed', 'notes'],
}

const MERGE_SCHEMA = {
  type: 'object',
  properties: { merged: { type: 'array' }, conflicts: { type: 'array' } },
  required: ['merged', 'conflicts'],
}

const planResultsByTask = new Map()
const verifyResultsByTask = new Map()
const implementResultsByTask = new Map()
const testResultsByGroup = new Map()
const typecheckResults = []
let requeueCount = 0

const runPlanner = (t) => {
  const options = { label: `plan:${t.number}`, phase: 'Plan', schema: PLAN_SCHEMA }
  if (PLAN_MODEL) options.model = PLAN_MODEL
  return agent(plannerBrief(t), options)
}

async function planStage(group) {
  return parallel(group.tasks.map((t) => () => runPlanner(t)))
}

const runVerifier = (t, planFile) =>
  agent(verifierBrief(t, planFile), { label: `verify:${t.number}`, phase: 'Verify', effort: 'low', schema: VERIFY_SCHEMA })

async function verifyStage(plans, group) {
  const planByNumber = new Map((plans ?? []).filter(Boolean).map((p) => [p.task, p]))
  for (const t of group.tasks) {
    if (!planByNumber.has(t.number)) {
      planByNumber.set(t.number, { task: t.number, status: 'needs-clarification', planFile: '', question: 'planner returned no result' })
    }
  }
  for (const plan of planByNumber.values()) planResultsByTask.set(plan.task, plan)

  const plannedTasks = group.tasks.filter((t) => planByNumber.get(t.number).status === 'planned')
  const verifyResults = await parallel(plannedTasks.map((t) => () => runVerifier(t, planByNumber.get(t.number).planFile)))
  plannedTasks.forEach((t, i) => {
    const v = verifyResults[i] ?? { task: t.number, verdict: 'rejected', notes: 'verifier agent returned no result (killed, errored, or blocked)' }
    verifyResultsByTask.set(t.number, v)
  })

  return group.tasks.map((t) => ({ plan: planByNumber.get(t.number), verify: verifyResultsByTask.get(t.number) ?? null }))
}

const runWorker = (t, group, planFile, note) => {
  const options = { label: `task:${t.number}`, phase: 'Implement', schema: WORKER_SCHEMA }
  if (WORKER_MODEL) options.model = WORKER_MODEL
  return agent(workerBrief(t, group, planFile, note, TYPECHECK_COMMAND), options)
}

async function implementStage(verified, group) {
  const verifiedByNumber = new Map((verified ?? []).map((v) => [v.plan.task, v]))
  const approvedTasks = group.tasks.filter((t) => {
    const v = verifiedByNumber.get(t.number)
    return v?.plan.status === 'planned' && v?.verify?.verdict === 'approved'
  })

  const results = []
  for (const t of approvedTasks) {
    const planFile = verifiedByNumber.get(t.number).plan.planFile
    const result = await runWorker(t, group, planFile, '')
    results.push(result ?? { task: t.number, status: 'blocked', summary: 'worker agent returned no result (killed, errored, or blocked)', remaining: [] })
  }

  for (const r of results.filter((r) => r.status === 'partial')) {
    requeueCount++
    const t = approvedTasks.find((task) => task.number === r.task)
    const planFile = verifiedByNumber.get(t.number).plan.planFile
    const note = `A previous worker finished part of this plan; still remaining: ${r.remaining.join('; ')}. Check the file state before redoing anything.`
    const redone = await runWorker(t, group, planFile, note)
    results[results.findIndex((x) => x.task === r.task)] = redone
  }

  for (const r of results) implementResultsByTask.set(r.task, r)
  return results
}

const runTester = (group, doneTasks) =>
  agent(testerBrief(group, doneTasks), { label: `test:${group.groupId}`, phase: 'Test', effort: 'low', schema: TEST_SCHEMA })

async function testStage(implementResults, group) {
  const doneTasks = group.tasks.filter((t) => (implementResults ?? []).some((r) => r.task === t.number && r.status === 'done'))
  if (!doneTasks.length) return implementResults

  const testResult = await runTester(group, doneTasks)
  const outcome = testResult ?? { passed: false, failures: doneTasks.map((t) => ({ task: t.number, detail: 'test agent returned no result (killed, errored, or blocked)' })) }
  testResultsByGroup.set(group.groupId, { groupId: group.groupId, ...outcome })
  if (outcome.passed) return implementResults

  const results = [...implementResults]
  for (const f of outcome.failures) {
    const t = doneTasks.find((task) => task.number === f.task)
    if (!t) continue
    requeueCount++
    const planFile = planResultsByTask.get(t.number).planFile
    const note = `A follow-up test run found a failure in files you own: ${f.detail}. Fix it.`
    const redone = await runWorker(t, group, planFile, note)
    const idx = results.findIndex((r) => r.task === t.number)
    const outcomeResult = redone ?? { task: t.number, status: 'blocked', summary: 'worker agent returned no result on test-fix retry', remaining: [] }
    results[idx] = outcomeResult
    implementResultsByTask.set(t.number, outcomeResult)
  }
  return results
}

async function typecheckStage(implementResults, group) {
  const result = await agent(
    `cd ${group.worktree} and run: ${TYPECHECK_COMMAND}
Report only — do not edit any file. If it fails, set passed=false and put the first errors in notes.`,
    { label: `typecheck:${group.groupId}`, phase: 'Typecheck', effort: 'low', schema: TYPECHECK_SCHEMA },
  )
  const outcome = { groupId: group.groupId, passed: result?.passed ?? false, notes: result?.notes ?? 'typecheck agent returned no result' }
  typecheckResults.push(outcome)
  return outcome
}

log(`${GROUPS.length} group(s), ${GROUPS.reduce((n, g) => n + g.tasks.length, 0)} task(s)`)
await pipeline(GROUPS, planStage, verifyStage, implementStage, testStage, typecheckStage)

const needsClarification = [...planResultsByTask.values()].filter((r) => r.status === 'needs-clarification')
const notRelevant = [...planResultsByTask.values()].filter((r) => r.status === 'not-relevant')
const rejected = [...verifyResultsByTask.values()].filter((r) => r.verdict === 'rejected')
const implementResults = [...implementResultsByTask.values()]
const partial = implementResults.filter((r) => r.status === 'partial')
const blocked = implementResults.filter((r) => r.status === 'blocked')

const mergeCliInput = {
  repo: REPO,
  typecheckCommand: TYPECHECK_COMMAND,
  groups: GROUPS,
  repositorySources: ARGS.repositorySources,
  runId: ARGS.runId,
  startTimestamp: ARGS.startTimestamp,
  doneCount: implementResults.filter((r) => r.status === 'done').length,
  partialCount: partial.length,
  blockedCount: blocked.length,
  needsClarificationCount: needsClarification.length,
  rejectedCount: rejected.length,
  requeueCount,
}

const mergeResult = await agent(
  `Run exactly this command and return its stdout as JSON, unmodified — do
not parse, summarize, reformat, or edit it. Do not run any other command.
Do not edit any file.

node "${ARGS.mergeScript}" '${JSON.stringify(mergeCliInput)}'`,
  { label: 'merge:repo', phase: 'Merge', effort: 'low', schema: MERGE_SCHEMA },
)

return {
  merged: mergeResult?.merged ?? [],
  conflicts: mergeResult?.conflicts ?? [],
  needsClarification,
  notRelevant,
  rejected,
  partial,
  blocked,
  typecheck: typecheckResults,
  tests: [...testResultsByGroup.values()],
}
```

### Per-line rationale for the parts that aren't a direct copy of the existing file

- **`verifyStage` returns `{plan, verify}` for every task in the group, not
  just the planned ones.** `implementStage` needs to look up any task by
  number to decide whether to run it; a partial list would force it to
  re-derive "was this task even planned" from absence, which is exactly the
  kind of implicit-state guessing the existing code avoids everywhere else
  (compare to how `planByNumber` explicitly fills in missing planner
  results instead of leaving gaps).
- **`verifyStage` only calls the verifier for tasks whose plan status is
  `'planned'`.** Verifying a plan that doesn't exist (`needs-clarification`,
  `not-relevant`) has nothing to check — those tasks already have their
  final disposition from the Plan phase.
- **`implementStage`'s gate checks both `plan.status === 'planned'` AND
  `verify.verdict === 'approved'`.** This is the literal "gating which
  planned tasks reach Implement" from the brief — a planned-but-rejected
  task must stop here, same as a needs-clarification task already does.
- **`testStage` only tests tasks whose *final* implement status is
  `'done'`.** `'done'` is the only status that means "committed, stable
  file state." `'blocked'`/leftover-`'partial'` tasks didn't commit, so
  there's nothing new on disk for those files to test.
- **`testStage`'s requeue is one-pass**, mirroring `implementStage`'s
  existing partial-requeue loop (`meta.phases` already documents that
  pattern as "one-pass requeue for partial" — Test's detail line says the
  same thing on purpose, for consistency).
- **`rejectedCount` added to `mergeCliInput`.** The three existing gating
  buckets (`needsClarificationCount`, `partialCount`, `blockedCount`) are
  already threaded through to the merge script as report data; `rejected`
  is structurally the same kind of bucket (tasks that stopped before
  Implement), so it's added for symmetry. This is additive only — it does
  not change any existing key the merge script already reads.
- **`workerBrief(t, group, planFile, note, TYPECHECK_COMMAND)`** — the 5th
  argument is `TYPECHECK_COMMAND` from this file's own `ARGS`, passed in
  because `workerBrief` no longer has closure access to it (see Step 1
  callout).

---

## Verification

1. Confirm both files exist and `tackle-tasks.workflow.js` is a strict
   subset+addition of the file quoted in the brief (no accidental logic
   drift in the unchanged stages: `planStage`, `typecheckStage`, the
   `mergeResult` call, and the shape of `WORKER_SCHEMA`/`PLAN_SCHEMA` must
   all read identically to before).
2. `wc -l skills/tackle-tasks/tackle-tasks.workflow.js
   skills/tackle-tasks/tackle-tasks.briefs.js` — both must be ≤ 250 lines.
3. `node --check skills/tackle-tasks/tackle-tasks.workflow.js` and
   `node --check skills/tackle-tasks/tackle-tasks.briefs.js` — catches
   syntax errors before relying on the (unknown-to-this-plan) runner to
   catch them.
4. Grep the repo for any other place that imports `tackle-tasks.workflow.js`
   symbols directly (e.g. a test file) — if one exists and imports
   `plannerBrief`/`workerBrief` from the workflow file, its import must be
   updated to point at `tackle-tasks.briefs.js` instead.
5. No changes to `scripts/relatedTests.ts`, `scripts/testPolicy.ts`, or any
   file outside the two listed above.
