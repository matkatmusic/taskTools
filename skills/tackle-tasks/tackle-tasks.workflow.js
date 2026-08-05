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
