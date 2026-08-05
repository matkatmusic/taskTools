export const meta = {
  name: 'tackle-tasks-verify',
  description: 'Review each plan with codex before it reaches an implementer',
  phases: [{ title: 'Verify', detail: 'one codex verifier per planned task' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const PLANNED = ARGS.planned ?? []
const TASK_BY_NUMBER = new Map((ARGS.groups ?? []).flatMap((g) => g.tasks).map((t) => [t.number, t]))

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    notes: { type: 'string' },
  },
  required: ['task', 'verdict', 'notes'],
}

const codexPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line, then one short paragraph saying why.`

const verifierBrief = (t, planFile) => `Run exactly this command, and do not
edit any file yourself:

codex exec -s read-only ${JSON.stringify(codexPrompt(t, planFile))}

Codex reviews the plan for task #${t.number} and prints its verdict on the
first line. Read that output.

If the verdict line says APPROVED, return verdict "approved". If it says
REJECTED, return verdict "rejected" and copy codex's reasoning into notes —
that reason is the only thing anyone sees before the task is skipped. If
codex fails to run, or prints no usable verdict, return verdict "rejected"
and put what went wrong in notes.
Return {task: ${t.number}, verdict, notes}.`

log(`verifying ${PLANNED.length} plan(s) with codex`)

const results = await parallel(PLANNED.map((p) => () =>
  agent(verifierBrief(TASK_BY_NUMBER.get(p.task), p.planFile), {
    label: `verify:${p.task}`,
    phase: 'Verify',
    effort: 'low',
    schema: VERIFY_SCHEMA,
  })))

const verified = PLANNED.map((p, i) => results[i] ?? {
  task: p.task,
  verdict: 'rejected',
  notes: 'verifier agent returned no result (killed, errored, or blocked)',
})

const planFileFor = (task) => PLANNED.find((p) => p.task === task).planFile

return {
  verified,
  approved: verified.filter((v) => v.verdict === 'approved').map((v) => ({ ...v, planFile: planFileFor(v.task) })),
  rejected: verified.filter((v) => v.verdict === 'rejected'),
}
