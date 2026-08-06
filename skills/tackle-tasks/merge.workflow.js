export const meta = {
  name: 'tackle-tasks-merge-unblock',
  description: 'Diagnose and fix the blockers from a failed merge run so the caller can run the merge script again',
  phases: [
    { title: 'Unblock', detail: 'diagnose and fix merge blockers' },
  ],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args

const DIAGNOSE_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'boolean' },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
  },
  required: ['fixed', 'summary', 'blockers', 'decisions'],
}

// The orchestrator gets the user's approval before this workflow is ever launched.
if (!ARGS.approvedByUser) {
  return { fixed: false, summary: '', blockers: ['merge unblock workflow launched without approvedByUser'], decisions: [] }
}

const answeredDecisions = ARGS.decisions ?? []
const answeredBlock = answeredDecisions.length === 0
  ? ''
  : `\nThe user already answered these choices — apply them instead of returning them again:\n${answeredDecisions.map((answer) => `  - ${answer}`).join('\n')}\n`

const diagnoseBrief = `The merge failed.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

repo = ${ARGS.repo}
failedCommand = ${ARGS.failedCommand}
report = ${JSON.stringify({ conflicts: ARGS.conflicts ?? [], error: ARGS.error ?? '' })}
${answeredBlock}
decisions = []
blockers = []

for each conflict in report.conflicts:
    if conflict.submoduleConflicts is not empty:
        run scripts/resolveGitlinkConflicts against conflict.worktree
    else if conflict.conflictedFilePaths is not empty:
        for each path in conflict.conflictedFilePaths:
            resolve path in conflict.worktree, keeping BOTH sides' intent
        stage only those paths, then commit

if report.error names a gitlink or submodule path:
    run scripts/resolveGitlinkConflicts against the named worktree
else if report.error names unmerged paths, an unfinished merge, or an unclean tree:
    complete the in-progress merge, or abort it, so the tree is clean
else if report.error is unrecognized:
    identify the real cause
    fix it only if the fix is as concrete and reversible as the branches above

if a blocker needs a user decision (both sides changed the same logic, a
recorded source branch is missing, or the only way forward destroys work):
    leave the repo exactly as you found it
    decisions += the choice itself, with the options you saw
    // example: "group-1 rewrote validateInput() while main deleted it:
    //           keep group-1's version, keep the deletion, or merge both?"

if something else stopped you (a tool failed, no permission, a state you could
not reach):
    blockers += one sentence naming it

if decisions is empty and blockers is empty:
    return {fixed: true, summary: what you changed, blockers: [], decisions: []}
else:
    return {fixed: false, summary: how far you got, blockers: blockers, decisions: decisions}

You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset anything you did not create; to run
failedCommand yourself; or to decide anything in decisions on the user's
behalf. Each entry in decisions must be answerable without opening the repo.
Returning a decision is a correct outcome, not a failure.`

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

log('diagnosing the failed merge')
const diagnosis = await retryAgent(() => agent(diagnoseBrief, { label: 'merge:unblock', phase: 'Unblock', schema: DIAGNOSE_SCHEMA }))

if (diagnosis === null || diagnosis === undefined) {
  return {
    fixed: false,
    summary: 'no structured diagnosis was returned after 3 attempts; inspect the repository, because an earlier attempt may have changed it',
    blockers: ['the diagnosing agent returned no result after 3 attempts'],
    decisions: [],
  }
}

// A pending decision blocks the retry even when the agent reported fixed.
const decisionsPending = (diagnosis.decisions?.length ?? 0) > 0

return {
  fixed: diagnosis.fixed === true && decisionsPending === false,
  summary: diagnosis.summary,
  blockers: diagnosis.blockers,
  decisions: diagnosis.decisions,
}
