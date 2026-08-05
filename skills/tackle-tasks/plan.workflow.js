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
Read ONLY this brief file (do not read any other file): ${t.briefFile}
Follow ~/.claude/guides/planning.md and write the plan to exactly this path: ${t.planFile}
Do not change any source file — this is planning only, not implementation.
If the task is unclear, set status "needs-clarification" and put your
question in "question". If the task no longer applies to the codebase, set
status "not-relevant" and explain why in "question". Otherwise write the
plan file and set status "planned".
Return {task: ${t.number}, status, planFile: "${t.planFile}", question}.`

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
