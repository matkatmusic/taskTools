export const meta = {
  name: 'tackle-tasks-merge',
  description: 'Run the merge script, and on failure have a subagent diagnose and fix the blockers before running it again',
  phases: [
    { title: 'Merge', detail: 'run mergeTaskWorktrees.ts' },
    { title: 'Unblock', detail: 'diagnose and fix merge blockers, then merge again' },
  ],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args

const RUN_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    merged: { type: 'array' },
    conflicts: { type: 'array' },
    error: { type: 'string' },
  },
  required: ['ok', 'merged', 'conflicts', 'error'],
}

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
  return { merged: [], conflicts: [], refused: 'merge workflow launched without approvedByUser' }
}

const mergeCliInput = {
  repo: ARGS.repo,
  typecheckCommand: ARGS.typecheckCommand ?? 'npx tsc --noEmit',
  groups: ARGS.groups ?? [],
  repositorySources: ARGS.repositorySources,
  runId: ARGS.runId,
  startTimestamp: ARGS.startTimestamp,
  doneCount: ARGS.doneCount ?? 0,
  partialCount: ARGS.partialCount ?? 0,
  blockedCount: ARGS.blockedCount ?? 0,
  needsClarificationCount: ARGS.needsClarificationCount ?? 0,
  rejectedCount: ARGS.rejectedCount ?? 0,
  requeueCount: ARGS.requeueCount ?? 0,
}

const command = `node "${ARGS.mergeScript}" '${JSON.stringify(mergeCliInput)}'`

const runBrief = `Run exactly this command and do not edit any file:

${command}

On success it prints JSON {merged, conflicts} on stdout — return ok=true with
those two arrays copied verbatim and error="". Copy them; do not parse,
summarize, or reformat.

If the command exits non-zero or prints no usable JSON, return ok=false,
merged=[], conflicts=[], and put the stderr and exit code in error.`

const diagnoseBrief = (run) => `The tackle-tasks merge failed. This is the command that was run:

${command}

What it reported:
${JSON.stringify({ ok: run.ok, conflicts: run.conflicts ?? [], error: run.error ?? '' })}

Repo: ${ARGS.repo}

Diagnose why the merge could not complete, then fix it if the fix is within
your reach. Typical causes and their fixes:
- Submodule gitlink pointer conflicts — this repo has resolveGitlinkConflicts
  in scripts/, which auto-resolves them. Look there before hand-editing.
- Ordinary file-level merge conflicts in a group worktree — resolve them in
  the worktree, keeping BOTH sides' intent, and commit the resolution.
- A dirty or half-merged worktree — finish or abort the in-progress merge so
  the tree is clean.

Do not weaken, delete, or stub out code to make a conflict disappear, and do
not force-push or hard-reset anything you did not create. Do not run the merge
command yourself — this workflow runs it again once you report back.

Some blockers are not yours to decide: two sides changed the same logic in
ways that genuinely conflict, a recorded source branch is missing, or the only
way forward destroys work. You are not expected to resolve those, and
returning one is a correct outcome, not a failure. When you hit one:
  1. Stop working on it and leave the repo as you found it.
  2. Return fixed=false.
  3. Add one entry to "decisions" phrased as the choice itself, with the
     options you actually saw — for example "group-1 rewrote validateInput()
     while main deleted it: keep group-1's version, keep the deletion, or
     merge both?".
The caller puts each entry in "decisions" to the user, the user chooses, and
the merge is retried with that answer. So write each one so a human can answer
it without opening the repo. Never pick for them, and never guess.

Use "blockers" for the other kind: something that stopped you but that nobody
needs to decide — a tool that failed, a command you lacked permission to run,
a state you could not reach. One concrete sentence each.

If you cleared every blocker so the merge can be retried, return fixed=true,
say what you did in summary, and leave both arrays empty.
Return {fixed, summary, blockers, decisions}.`

const runMergeScript = (attempt) =>
  agent(runBrief, { label: `merge:run${attempt}`, phase: 'Merge', effort: 'low', schema: RUN_SCHEMA })

const failed = (run) => !run || !run.ok || (run.conflicts?.length ?? 0) > 0

log(`merging ${mergeCliInput.groups.length} group(s)`)
const first = await runMergeScript(1)

if (!failed(first)) {
  return { merged: first.merged, conflicts: [], fixedBlockers: null, blockers: [], decisions: [] }
}

log('merge failed — diagnosing')
const diagnosis = await agent(
  diagnoseBrief(first ?? { ok: false, conflicts: [], error: 'merge agent returned no result' }),
  { label: 'merge:unblock', phase: 'Unblock', schema: DIAGNOSE_SCHEMA },
)

if (!diagnosis?.fixed) {
  return {
    merged: first?.merged ?? [],
    conflicts: first?.conflicts ?? [],
    fixedBlockers: false,
    blockers: diagnosis?.blockers ?? ['the diagnosing agent returned no result'],
    decisions: diagnosis?.decisions ?? [],
    summary: diagnosis?.summary ?? '',
  }
}

log('blockers cleared — merging again')
const retry = await runMergeScript(2)

return {
  merged: retry?.merged ?? [],
  conflicts: retry?.conflicts ?? [],
  fixedBlockers: true,
  blockers: failed(retry) ? ['merge still failed after the fix; see conflicts and error'] : [],
  decisions: [],
  summary: diagnosis.summary,
  error: retry?.error ?? '',
}
