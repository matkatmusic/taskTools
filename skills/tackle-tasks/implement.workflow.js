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

const workerBrief = (t, group, planFile, note) => `You are implementing EXACTLY ONE pre-planned task from ./.taskTools/tasks.json: #${t.number}.
Repo root (cd here first): ${group.worktree}
Files you own (touch nothing outside them): ${t.files.join(', ')}
${note}
use jot:implement ${planFile}

Implement the plan exactly — no scope additions, no refactors the plan
doesn't call for. All design decisions were made in the plan; you are
executing, not deciding. If the plan is impossible as written, stop and
return status "blocked" with the reason in summary.

When the edits are done, run: ${TYPECHECK_COMMAND}
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
