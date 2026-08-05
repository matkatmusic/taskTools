# Task 54: Have create-task ask the user for an example test and store it as a tests field on the task

When using create-task, ask the user for an example of a test (most likely an e2e test) that will correctly test the thing they are adding. Offer an optional skip choice when asking. If the user picks skip, the implementing agent skips TDD and just writes code. Otherwise the implementing agent writes the test based on what the user wrote, and expands on it a bit to test subparts of what was built (i.e. test individual functions).

Purpose: skip the agent undirected TDD approach and give it an actual test to write the implementation around, one that reflects how the user wants the code to actually work.

Design notes: the answer has to survive past the create-task conversation, so store it on the task entry as a new field named tests, holding the user answer as prose or pseudocode, or the literal string skip. Add the field to skills/create-task/template/taskTemplate.json and document it in skills/create-task/SKILL.md alongside the AskUserQuestion prompt that collects it. Then consume it downstream: skills/tackle-tasks/plan.workflow.js must put the example test into the plan so codex verifies against it, and skills/tackle-tasks/implement.workflow.js workerBrief must instruct the worker to write that test first and expand it to cover individual functions, or to skip TDD entirely when tests is the string skip. Tasks created before this field exists must keep working, so treat a missing field the same as skip.

### skills/create-task/SKILL.md

```
---
name: create-task
description: the ONLY way to add a task to tasks.json. ALWAYS invoke this skill whenever any task is being added — whether it comes from the user, from another skill, or from your own work — never edit tasks.json directly. Use discernment — if $ARGUMENTS explains the task well enough, write it directly; if not, refine it with AskUserQuestion (or /grill-me for direction-setting tasks) first.
argument-hint: "<task description>"
---

- taskNumber to use: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`

Task described by the user: $ARGUMENTS

Decide whether that description is actionable later without this conversation's context: a concrete goal or symptom, plus file paths / repro steps / URLs where applicable. If it is, proceed. If not, invoke AskUserQuestion to fill the specific gaps; for a large or direction-setting task, invoke `/grill-me` instead to refine it.

Append ONE object to the `tasks.json` array as its LAST element — at the very end of the array, after every existing entry. Never insert it in the middle and never reorder or renumber the existing entries. Use this template:

```json
!`cat "${CLAUDE_PLUGIN_ROOT}/skills/create-task/template/taskTemplate.json"`
```

Populate `files` with the repo-relative paths the task will touch, including test files. If they genuinely cannot be determined, omit the field entirely rather than guessing.

If the request names the source note/handoff file(s) the task came from (e.g. an `update-tasks` harvest), also include `"handoffFilePaths": [<those repo-relative paths>]` in the object; otherwise omit the field.

If `specs/SPEC.md` exists and this task belongs to one of its spec items, append the task number to that item's `Tasks:` line.

Omit completion-related fields (`completionDate`, `commitHashes`, `closureNote`) — those belong to `completedTasks.json`, which this skill never touches.

Finally, confirm to the user: the task number and title that were added.

```

### skills/create-task/template/taskTemplate.json

```
{
  "taskNumber": <the injected number above>,
  "title": "<short summary of the task>",
  "description": "<the task in the user's own wording, plus any refinements gathered; include file paths and repro URLs if given>",
  "files": ["<repo-relative path this task will touch>"],
  "difficulty": <implementation effort and risk, NOT importance: 1 = one-line or single-file mechanical change; 2 = contained change to one file plus its test; 3 = several files in one subsystem, design already settled; 4 = crosses subsystems or needs design decisions during implementation; 5 = wide blast radius, unclear scope, or a previously reverted attempt>,
  "blockedBy": [<task numbers of any tasks that must be completed first; omit the field if none>]
}

```

### skills/tackle-tasks/plan.workflow.js

```
export const meta = {
  name: 'tackle-tasks-plan',
  description: 'Write one plan file per task, one planner agent each',
  phases: [{ title: 'Plan', detail: 'one planner agent per task' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const GROUPS = ARGS.groups ?? []
const PLAN_MODEL = ARGS.planModel

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

const TASKS = GROUPS.flatMap((g) => g.tasks)
log(`planning ${TASKS.length} task(s)`)

const runPlanner = (t) => {
  const options = { label: `plan:${t.number}`, phase: 'Plan', schema: PLAN_SCHEMA }
  if (PLAN_MODEL) options.model = PLAN_MODEL
  return agent(plannerBrief(t), options)
}

const results = await parallel(TASKS.map((t) => () => runPlanner(t)))
const plans = TASKS.map((t, i) => results[i] ?? {
  task: t.number,
  status: 'needs-clarification',
  planFile: '',
  question: 'planner returned no result',
})

return {
  plans,
  planned: plans.filter((p) => p.status === 'planned'),
  needsClarification: plans.filter((p) => p.status === 'needs-clarification'),
  notRelevant: plans.filter((p) => p.status === 'not-relevant'),
}

```

### skills/tackle-tasks/implement.workflow.js

```
export const meta = {
  name: 'tackle-tasks-implement',
  description: 'Implement each approved plan with jot:implement, serially per group',
  phases: [{ title: 'Implement', detail: 'serial workers per group, one-pass requeue for partial' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const GROUPS = ARGS.groups ?? []
const APPROVED = ARGS.approved ?? []
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
const WORKER_MODEL = ARGS.workerModel
const MAX_FIX_ROUNDS = ARGS.maxRounds ?? 3

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

const workerBrief = (t, group, planFile, note) => `You are implementing EXACTLY ONE pre-planned task from
./.taskTools/tasks.json: #${t.number}.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

run(cd ${group.worktree})
ownedFiles = ${t.files.join(', ')}
plan = ${planFile}
timeBudget = 10 minutes
${note ? `note = ${note}\n` : ''}
use jot:implement ${planFile}

if the plan is impossible as written:
    return {task: ${t.number}, status: "blocked", summary: why it cannot be done, remaining: []}

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
    return {task: ${t.number}, status: "blocked", summary: what is still failing after ${MAX_FIX_ROUNDS} fix rounds, remaining: the failing test names}

if typecheck is clean and every test passed:
    run: ${t.files.length ? `git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}` : 'git add -- (every path you edited, listed explicitly)'}
    run: git commit -m "task ${t.number}: one-line summary"
    return {task: ${t.number}, status: "done", summary: one sentence, remaining: []}
else if part of the plan is implemented:
    return {task: ${t.number}, status: "partial", summary: one sentence, remaining: the plan steps not yet done, plus any failing test names}
else:
    return {task: ${t.number}, status: "blocked", summary: one sentence, remaining: the failing test names}

if you reach timeBudget before finishing:
    return status "partial" with the not-yet-done plan steps in remaining

You are forbidden to touch anything outside ownedFiles; to add scope or
refactors the plan does not call for; to redecide anything the plan already
decided; to run the full suite, \`git add -A\`, or \`git add .\`; to commit while
anything fails; to attempt more than ${MAX_FIX_ROUNDS} fix rounds; or to return
status "done" with a failing test.`

const planFileFor = (task) => APPROVED.find((a) => a.task === task)?.planFile ?? ''

const runWorker = (t, group, note) => {
  const options = { label: `task:${t.number}`, phase: 'Implement', schema: WORKER_SCHEMA }
  if (WORKER_MODEL) options.model = WORKER_MODEL
  return agent(workerBrief(t, group, planFileFor(t.number), note), options)
}

let requeueCount = 0

async function implementGroup(group) {
  const tasks = group.tasks.filter((t) => APPROVED.some((a) => a.task === t.number))
  const results = []
  for (const t of tasks) {
    const result = await runWorker(t, group, '')
    results.push(result ?? {
      task: t.number,
      status: 'blocked',
      summary: 'worker agent returned no result (killed, errored, or blocked)',
      remaining: [],
    })
  }

  for (const r of results.filter((r) => r.status === 'partial')) {
    requeueCount++
    const t = tasks.find((task) => task.number === r.task)
    const note = `A previous worker finished part of this plan; still remaining: ${r.remaining.join('; ')}. Check the file state before redoing anything.`
    const redone = await runWorker(t, group, note)
    results[results.findIndex((x) => x.task === r.task)] = redone ?? r
  }

  return results
}

log(`implementing ${APPROVED.length} approved task(s) across ${GROUPS.length} group(s)`)
const perGroup = await parallel(GROUPS.map((g) => () => implementGroup(g)))
const results = perGroup.filter(Boolean).flat()

return {
  results,
  done: results.filter((r) => r.status === 'done'),
  partial: results.filter((r) => r.status === 'partial'),
  blocked: results.filter((r) => r.status === 'blocked'),
  requeueCount,
}

```
