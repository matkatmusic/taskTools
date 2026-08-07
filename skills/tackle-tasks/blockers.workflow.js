import { BLOCKER_VERDICTS, BLOCKER_VERDICT_VALUES, BLOCKER_VERDICT_SCHEMA_FRAGMENT, buildBlockerInvestigationPrompt } from '../../scripts/blockerVerdicts.ts'

export const meta = {
  name: 'tackle-tasks-blockers',
  description: 'Investigate each blocked-task/blocker pair with one subagent, so a disproven reason can be stripped before the run',
  phases: [{ title: 'Blockers', detail: 'one investigator per blocked-task/blocker pair' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const PAIRS = ARGS.pairs ?? []

const BLOCKER_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    verdict: BLOCKER_VERDICT_SCHEMA_FRAGMENT,
    notes: { type: 'string' },
  },
  required: ['id', 'verdict', 'notes'],
}

const pairId = (pair) => JSON.stringify([pair.blockedTask, pair.blockerTask, pair.reason])

const investigatorBrief = (pair) => `Invoke /ponytail:ponytail ultra.
${buildBlockerInvestigationPrompt(pair.blockedTask, pair.blockerTask, pair.reason)}

Source code and git history are the truth for this project — do not trust stale docs. Read the codebase and recent git history/commits (git log, git show) to check whether that reason still holds against the current state of the code. You may run read-only Bash and Read commands; do not edit any file.

Return verdict "${BLOCKER_VERDICTS.DISPROVEN}" only if you find clear evidence in the current code or git history that the reason no longer applies. Otherwise, or if you cannot tell, return verdict "${BLOCKER_VERDICTS.STILL_BLOCKED}" — when unsure, stay blocked.

Return {id: ${JSON.stringify(pairId(pair))}, verdict, notes} where notes explains what you found. The id must be copied exactly as given — it is how the orchestrator matches your answer back to this pair.`

log(`investigating ${PAIRS.length} blocker reason(s)`)

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

const results = await parallel(PAIRS.map((pair) => () =>
  retryAgent(() => agent(investigatorBrief(pair), {
    label: `blocker:${pair.blockedTask}:${pair.blockerTask}`,
    phase: 'Blockers',
    schema: BLOCKER_SCHEMA,
  }))))

const isValidVerdict = (pair, result) =>
  result != null
  && result.id === pairId(pair)
  && BLOCKER_VERDICT_VALUES.includes(result.verdict)
  && typeof result.notes === 'string'

const verdicts = PAIRS.map((pair, i) => {
  const result = results[i]
  const valid = isValidVerdict(pair, result)
  return {
    ...pair,
    verdict: valid && result.verdict === BLOCKER_VERDICTS.DISPROVEN ? BLOCKER_VERDICTS.DISPROVEN : BLOCKER_VERDICTS.STILL_BLOCKED,
    notes: valid
      ? result.notes
      : result == null
        ? 'investigator agent returned no result after 3 attempts (killed, errored, or blocked)'
        : 'investigator agent returned a malformed or mismatched result (bad id, verdict, or notes) — treated as still-blocked',
  }
})

return {
  disproven: verdicts.filter((v) => v.verdict === BLOCKER_VERDICTS.DISPROVEN),
  stillBlocked: verdicts.filter((v) => v.verdict === BLOCKER_VERDICTS.STILL_BLOCKED),
}
