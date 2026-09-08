export const meta = {
  name: 'tackle-tasks-verify',
  description: 'Review each plan with codex (or Claude when codex is down), apply its fixes once, and re-review before rejecting',
  phases: [{ title: 'Verify', detail: 'one verifier per planned task, one repair round each' }],
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
    reviewer: { type: 'string', enum: ['codex', 'claude'] },
  },
  required: ['task', 'verdict', 'revised', 'notes', 'reviewer'],
}

const codexPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, say so explicitly in FIXES instead of inventing a fix.`

const RECHECK_SUFFIX = `

The plan you are reading has already been revised in answer to your previous review. Check one more time to see if ONLY the issues you flagged in the previous review were resolved. Do not look for new issues.`

// already shell-quoted — the agent pastes it verbatim, quotes included
const quotedPrompt = (t, planFile, suffix = '') => JSON.stringify(codexPrompt(t, planFile) + suffix)

// ponytail: last fallback is opus/high, not fable/medium — it replaces the strictest gate in the pipeline
const verifierBrief = (t, planFile) => `Review the plan for task #${t.number}.

## PROMPT-A (first round)

\`\`\`text
${quotedPrompt(t, planFile)}
\`\`\`

## PROMPT-B (re-check, second round only)

\`\`\`text
${quotedPrompt(t, planFile, RECHECK_SUFFIX)}
\`\`\`

Each prompt above is already shell-quoted. Paste it verbatim, surrounding
double quotes included, wherever a command below says PROMPT-A or PROMPT-B.
Never retype, reflow, or re-escape it.

## Reviewers

  codex:  codex exec -s read-only PROMPT
  fable:  claude --tools "Read" --model fable --effort medium -p PROMPT
  opus:   claude --tools "Read" --model claude-opus-4-8 --effort high -p PROMPT

Run the codex command with PROMPT-A first. If it exits with an error code,
codex is unavailable — not a verdict. Unavailability looks like a non-zero
exit with no APPROVED or REJECTED first line and no PROBLEMS or FIXES block:
overloaded api, usage exceeded, not logged in, rate limited, or no codex
binary on PATH. In that case run the fable command with PROMPT-A, and treat
its output exactly as you would codex's. If that also exits with an error
code, run the opus command with PROMPT-A the same way.

Whichever reviewer answers prints its verdict on the first line. The only
file you may ever edit is the plan file ${planFile} — never touch a source
file, and never run any command other than the ones above.

Report which reviewer actually produced the verdict you return: reviewer
"codex" if the codex command answered, reviewer "claude" if you had to fall
back. Never report a fallback review as codex.

If the first run prints APPROVED:
  return verdict "approved", revised false, and the reviewer's reasoning in notes.

If the first run prints REJECTED:
  it also prints a FIXES section. Apply those fixes to ${planFile} so the plan
  says what the reviewer asked for — edit only that file. Then run the same
  reviewer that answered a second time, using PROMPT-B — never PROMPT-A.

  If the second run prints APPROVED: return verdict "approved", revised true,
  and describe in notes what you changed in the plan.

  If the second run prints REJECTED: return verdict "rejected", revised true,
  and put the reviewer's second-round PROBLEMS and FIXES text in notes verbatim —
  that reason is the only thing anyone sees before the task is skipped.

  If the reviewer said the plan cannot be fixed within the task's owned files, do
  not invent a fix: return verdict "rejected", revised false, and copy that
  explanation into notes.

Never review more than twice in total, counting codex and the fallback together.
Return {task: ${t.number}, verdict, revised, notes, reviewer}.`

log(`verifying ${PLANNED.length} plan(s) with codex, up to one repair round each`)

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

const results = await parallel(PLANNED.map((p) => () =>
  retryAgent(() => agent(verifierBrief(TASK_BY_NUMBER.get(p.task), p.planFile), {
    label: `verify:${p.task}`,
    phase: 'Verify',
    schema: VERIFY_SCHEMA,
  }))))

const verified = PLANNED.map((p, i) => results[i] ?? {
  task: p.task,
  verdict: 'rejected',
  revised: false,
  notes: 'verifier agent returned no result after 3 attempts (killed, errored, or blocked)',
  reviewer: 'none',
})

const planFileFor = (task) => PLANNED.find((p) => p.task === task).planFile

const reviewHandoffs = verified.map((v) => `task ${v.task}: ${v.verdict} by ${v.reviewer}${v.revised ? ' (revised)' : ''} - ${v.notes}`)

return {
  verified,
  approved: verified.filter((v) => v.verdict === 'approved').map((v) => ({ ...v, planFile: planFileFor(v.task) })),
  rejected: verified.filter((v) => v.verdict === 'rejected'),
  revisedCount: verified.filter((v) => v.revised).length,
  reviewHandoffs,
}
