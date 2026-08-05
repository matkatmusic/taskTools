export const meta = {
  name: 'tackle-tasks-verify',
  description: 'Review each plan with codex, apply its suggested fixes once, and re-review before rejecting',
  phases: [{ title: 'Verify', detail: 'one codex verifier per planned task, one repair round each' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const PLANNED = ARGS.planned ?? []
const TASK_BY_NUMBER = new Map((ARGS.groups ?? []).flatMap((g) => g.tasks).map((t) => [t.number, t]))

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    revised: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['task', 'verdict', 'revised', 'notes'],
}

const codexPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, say so explicitly in FIXES instead of inventing a fix.`

const verifierBrief = (t, planFile) => {
  const command = `codex exec -s read-only ${JSON.stringify(codexPrompt(t, planFile))}`
  return `Review the plan for task #${t.number} by running exactly this command:

${command}

Codex prints its verdict on the first line. The only file you may ever edit
is the plan file ${planFile} — never touch a source file, and never run any
command other than the codex command above.

If the first run prints APPROVED:
  return verdict "approved", revised false, and codex's reasoning in notes.

If the first run prints REJECTED:
  it also prints a FIXES section. Apply those fixes to ${planFile} so the plan
  says what codex asked for — edit only that file. Then run the exact same
  codex command a second time against the now-updated plan.

  If the second run prints APPROVED: return verdict "approved", revised true,
  and describe in notes what you changed in the plan.

  If the second run prints REJECTED: return verdict "rejected", revised true,
  and put codex's second-round PROBLEMS and FIXES text in notes verbatim —
  that reason is the only thing anyone sees before the task is skipped.

  If codex said the plan cannot be fixed within the task's owned files, do not
  invent a fix: return verdict "rejected", revised false, and copy that
  explanation into notes.

Never run codex more than twice.
Return {task: ${t.number}, verdict, revised, notes}.`
}

log(`verifying ${PLANNED.length} plan(s) with codex, up to one repair round each`)

const results = await parallel(PLANNED.map((p) => () =>
  agent(verifierBrief(TASK_BY_NUMBER.get(p.task), p.planFile), {
    label: `verify:${p.task}`,
    phase: 'Verify',
    schema: VERIFY_SCHEMA,
  })))

const verified = PLANNED.map((p, i) => results[i] ?? {
  task: p.task,
  verdict: 'rejected',
  revised: false,
  notes: 'verifier agent returned no result (killed, errored, or blocked)',
})

const planFileFor = (task) => PLANNED.find((p) => p.task === task).planFile

return {
  verified,
  approved: verified.filter((v) => v.verdict === 'approved').map((v) => ({ ...v, planFile: planFileFor(v.task) })),
  rejected: verified.filter((v) => v.verdict === 'rejected'),
  revisedCount: verified.filter((v) => v.revised).length,
}
