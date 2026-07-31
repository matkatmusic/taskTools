export const meta = {
  name: 'tackle-tasks-fanout',
  description: 'Implement pre-planned disjoint-file tasks in parallel: one worker per plan file, typecheck-only, one requeue pass',
  phases: [
    { title: 'Implement', detail: 'one worker per task plan' },
    { title: 'Requeue', detail: 'second pass for partial workers' },
    { title: 'Typecheck', detail: 'whole-repo typecheck after all workers' },
  ],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const REPO = ARGS.repo
const TASKS = ARGS.tasks ?? []
const TYPECHECK = ARGS.typecheckCmd ?? 'npx tsc --noEmit'

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

const workerBrief = (t, note) => `You are implementing EXACTLY ONE pre-planned task: #${t.number}.
Repo root (cd here first): ${REPO}
Plan file: ${t.planFile}
Files you own (touch nothing outside them): ${t.files.join(', ')}
${note}
Read the plan file, then implement it exactly — no scope additions, no
refactors the plan doesn't call for. All design decisions were made in the
plan; you are executing, not deciding. If the plan is impossible as written,
stop and return status "blocked" with the reason in summary.

When the edits are done, run: ${TYPECHECK}
Fix type errors in the files you own; do not run test suites, visual checks,
or any other verification. Do NOT stage, commit, or generate commit messages.

Soft time budget: 10 minutes — if you cannot finish, stop and return status
"partial" with the not-yet-done plan steps listed in "remaining".
Return {task: ${t.number}, status, summary (one sentence), remaining}.`

const runWorker = (t, note, phase) =>
  agent(workerBrief(t, note), { label: `task:${t.number}`, phase, schema: WORKER_SCHEMA })

log(`${TASKS.length} pre-planned task(s)`)
const first = await parallel(TASKS.map((t) => () => runWorker(t, '', 'Implement')))
const byTask = new Map(first.filter(Boolean).map((r) => [r.task, r]))

const partials = TASKS.filter((t) => byTask.get(t.number)?.status === 'partial')
if (partials.length) {
  log(`Requeue pass: ${partials.length} partial task(s)`)
  const second = await parallel(partials.map((t) => () => {
    const prev = byTask.get(t.number)
    const note = `A previous worker finished part of this plan; still remaining: ${prev.remaining.join('; ')}. Check the file state before redoing anything.`
    return runWorker(t, note, 'Requeue')
  }))
  second.filter(Boolean).forEach((r) => byTask.set(r.task, r))
}

for (const t of TASKS) {
  if (!byTask.has(t.number)) {
    byTask.set(t.number, { task: t.number, status: 'blocked', summary: 'worker returned no result', remaining: [] })
  }
}

const typecheck = await agent(
  `cd ${REPO} and run: ${TYPECHECK}
Report only — do not edit any file. If it fails, set passed=false and put the first errors in notes.`,
  { label: 'typecheck:repo', phase: 'Typecheck', effort: 'low', schema: TYPECHECK_SCHEMA },
)

const results = [...byTask.values()]
const pick = (s) => results.filter((r) => r.status === s)
return {
  done: pick('done'),
  partial: pick('partial'),
  blocked: pick('blocked'),
  typecheckPassed: typecheck?.passed ?? false,
  typecheckNotes: typecheck?.notes ?? 'typecheck agent returned no result',
}
