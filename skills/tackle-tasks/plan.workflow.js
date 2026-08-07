import { execFileSync } from 'node:child_process'
import { readTaskFile, resolveTaskFiles } from '../../scripts/taskFiles.ts'
import { writeTaskBriefFile } from '../../scripts/prepareTasks.ts'

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
    missingFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['task', 'status', 'planFile', 'question'],
}

const testsInstruction = (t) => t.tests && t.tests !== 'skip'
  ? `The task's tests field holds an example test the user wrote — put it into the plan's verification section as the concrete check to run, expanded with a few extra cases covering the individual functions/subparts it touches: ${t.tests}`
  : 'This task has no tests field, or it is the literal string "skip" — do not require TDD; write ordinary verification commands in the plan instead.'

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

const TASKS = GROUPS.flatMap((g) => g.tasks)
log(`planning ${TASKS.length} task(s)`)

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

const runPlanner = (t) => {
  const options = { label: `plan:${t.number}`, phase: 'Plan', schema: PLAN_SCHEMA }
  if (PLAN_MODEL) options.model = PLAN_MODEL
  return retryAgent(() => agent(plannerBrief(t), options))
}

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
