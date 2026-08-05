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
if any test failed:
    fix the cause, then run typecheck and results again

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
anything fails; or to return status "done" with a failing test.`

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
