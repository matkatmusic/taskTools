# Task 40: workers should run their own tests as part of their task requirement

workers should run their own tests as part of their task requirement, and be responsible for fixing their failing tests before they signal to the orchestrating agent that their task is complete and ready to be merged.

Two places currently forbid this and must both change: skills/tackle-tasks/SKILL.md line 40 ("run typecheck only — no test suites or visual checks, by you or by workers") and the workerBrief template in skills/tackle-tasks/tackle-tasks.workflow.js ("Fix type errors in the files you own; do not run test suites"). Replace both with the requirement that a worker runs the tests covering the files it owns and fixes its own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Keep the full-suite run in close-tasks as the final gate.

### skills/tackle-tasks/SKILL.md

```
---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: "[N,N,...] [valid]"
allowed-tools: Bash(git add *)
---

- blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" '$ARGUMENTS'`
- task details (unblocked tasks only): !`u=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" --unblocked '$ARGUMENTS'); [ -n "$u" ] && node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" "$u" || echo "none of the requested tasks are unblocked"`
- pipeline args: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/prepareTasks.ts" '$ARGUMENTS'`

Invocation format: the task numbers come first as a JSON array with **no spaces** — `[268,270,281]` — followed by `valid` and any free text. The scripts above read the whole argument string and stop at the first token that is not part of the array, so anything after it is ignored by them. Avoid apostrophes and backticks in that trailing text; it reaches the shell inside single quotes.

Do not work on any task reported as BLOCKED in the "blocked status" above — report its open blockers and move on to the next requested task that is unblocked.

Invoke `/ponytail:ponytail ultra`.

When `$ARGUMENTS` contains the word `valid`, the user has confirmed the tasks are still relevant — skip the **Verification** section below and treat every unblocked task in the details above as open and relevant.

## Verification

Review the task details above (each object comes from `tasks.json` if the task is open, or `completedTasks.json` if it was already completed). Cross-reference the task with the codebase to determine if the task is still relevant or if it has been resolved.
Use the git history and recent commits (over the last 3 days) to confirm/deny the existence of the unblocked tasks detailed above.

Call Workflow with scriptPath "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/tackle-tasks.workflow.js"
and args set to the pipeline args JSON printed above, verbatim.

Present merged, conflicts, needsClarification and blocked to the user. Ask every
needsClarification question with AskUserQuestion. ONLY after the user approves, invoke
close-tasks once for all merged tasks.

There is no serial fallback path. One task or ten, the same code path runs.

## Closing your tasks

Close every task that is not problematic and was completed successfully, rendering its `tasks.json` entry stale, with **one** invocation of the `close-tasks` skill for all of them. Its first argument must be a JSON array of the task numbers with no spaces — `[268,270,281]` — followed by your reasoning for the `closureNote`s, naming each task (`#268 …, #270 …`) when the reasons differ.

If the user requests adding tasks, invoke the `create-task` skill once per task — never edit `tasks.json` directly.

During implementation, run typecheck only — no test suites or visual checks, by you or by workers. Full verification (typecheck + full suite + the repo's UI verification where relevant) runs once inside `close-tasks`, after the user approves closing.

## Commit message

Finally, follow these instructions:

!`cat "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/COMMIT_MESSAGES.md"`

```

### skills/tackle-tasks/tackle-tasks.workflow.js

```
export const meta = {
  name: 'tackle-tasks-pipeline',
  description: 'Plan, implement, and typecheck file-disjoint task groups as an overlapping pipeline, then merge each group back into the repo',
  phases: [
    { title: 'Plan', detail: 'one planner agent per task' },
    { title: 'Implement', detail: 'serial workers per group, one-pass requeue for partial' },
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
const implementResultsByTask = new Map()
const typecheckResults = []
let requeueCount = 0

const plannerBrief = (t) => `Invoke /ponytail:ponytail ultra.
Read ONLY this brief file (do not read any other file): ${t.briefFile}
Follow ~/.claude/guides/planning.md and write the plan to exactly this path: ${t.planFile}
Do not change any source file — this is planning only, not implementation.
If the task is unclear, set status "needs-clarification" and put your
question in "question". If the task no longer applies to the codebase, set
status "not-relevant" and explain why in "question". Otherwise write the
plan file and set status "planned".
Return {task: ${t.number}, status, planFile: "${t.planFile}", question}.`

const runPlanner = (t) => {
  const options = { label: `plan:${t.number}`, phase: 'Plan', schema: PLAN_SCHEMA }
  if (PLAN_MODEL) options.model = PLAN_MODEL
  return agent(plannerBrief(t), options)
}

async function planStage(group) {
  return parallel(group.tasks.map((t) => () => runPlanner(t)))
}

const workerBrief = (t, group, planFile, note) => `You are implementing EXACTLY ONE pre-planned task: #${t.number}.
Repo root (cd here first): ${group.worktree}
Plan file: ${planFile}
Files you own (touch nothing outside them): ${t.files.join(', ')}
${note}
Read the plan file, then implement it exactly — no scope additions, no
refactors the plan doesn't call for. All design decisions were made in the
plan; you are executing, not deciding. If the plan is impossible as written,
stop and return status "blocked" with the reason in summary.

When the edits are done, run: ${TYPECHECK_COMMAND}
Fix type errors in the files you own; do not run test suites, visual checks,
or any other verification.

When typecheck passes, commit from ${group.worktree}. Other tasks may share
this worktree, so stage ONLY your own paths — never \`git add -A\`, never \`git add .\`:
  ${t.files.length ? `git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}` : 'git add -- <list every path you edited, explicitly>'}
  git commit -m "task ${t.number}: <one-line summary>"

Soft time budget: 10 minutes — if you cannot finish, stop and return status
"partial" with the not-yet-done plan steps listed in "remaining".
Return {task: ${t.number}, status, summary (one sentence), remaining}.`

const runWorker = (t, group, planFile, note) => {
  const options = { label: `task:${t.number}`, phase: 'Implement', schema: WORKER_SCHEMA }
  if (WORKER_MODEL) options.model = WORKER_MODEL
  return agent(workerBrief(t, group, planFile, note), options)
}

async function implementStage(plans, group) {
  const planByNumber = new Map((plans ?? []).filter(Boolean).map((p) => [p.task, p]))
  for (const t of group.tasks) {
    if (!planByNumber.has(t.number)) {
      planByNumber.set(t.number, { task: t.number, status: 'needs-clarification', planFile: '', question: 'planner returned no result' })
    }
  }
  for (const plan of planByNumber.values()) planResultsByTask.set(plan.task, plan)

  const plannedTasks = group.tasks.filter((t) => planByNumber.get(t.number).status === 'planned')
  const results = []
  for (const t of plannedTasks) {
    const result = await runWorker(t, group, planByNumber.get(t.number).planFile, '')
    results.push(result ?? { task: t.number, status: 'blocked', summary: 'worker agent returned no result (killed, errored, or blocked)', remaining: [] })
  }

  for (const r of results.filter((r) => r.status === 'partial')) {
    requeueCount++
    const t = plannedTasks.find((task) => task.number === r.task)
    const note = `A previous worker finished part of this plan; still remaining: ${r.remaining.join('; ')}. Check the file state before redoing anything.`
    const redone = await runWorker(t, group, planByNumber.get(t.number).planFile, note)
    results[results.findIndex((x) => x.task === r.task)] = redone
  }

  for (const r of results) implementResultsByTask.set(r.task, r)
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
await pipeline(GROUPS, planStage, implementStage, typecheckStage)

const needsClarification = [...planResultsByTask.values()].filter((r) => r.status === 'needs-clarification')
const notRelevant = [...planResultsByTask.values()].filter((r) => r.status === 'not-relevant')
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
  partial,
  blocked,
  typecheck: typecheckResults,
}

```
