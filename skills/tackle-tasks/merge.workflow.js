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

const runBrief = `Run exactly this command. Do not edit any file. Do not run any other command.

${command}

Then return one of exactly two results. There is no third case.

CASE 1 — the command exited 0 AND its stdout is JSON containing both a
"merged" array and a "conflicts" array. Return:
{"ok": true, "merged": <the merged array, copied verbatim>, "conflicts": <the conflicts array, copied verbatim>, "error": ""}
Copy both arrays exactly as printed. Do not parse, summarize, reformat,
reorder, drop, or add fields.

CASE 2 — the command exited non-zero, OR printed nothing, OR printed output
that is not JSON containing both of those arrays. Return:
{"ok": false, "merged": [], "conflicts": [], "error": "exit <exit code>: <the full stderr, or the unusable stdout when stderr is empty>"}`

const diagnoseBrief = (run) => `The tackle-tasks merge failed. This is the command that was run:

${command}

What it reported:
${JSON.stringify({ ok: run.ok, conflicts: run.conflicts ?? [], error: run.error ?? '' })}

Repo: ${ARGS.repo}

Check each known cause below against what the command reported. When one
matches, apply its solution.

diagnosis: submodule gitlink pointer conflict — a conflicts entry has a
non-empty submoduleConflicts, or the error names a gitlink or submodule path.
solution: run the existing resolveGitlinkConflicts routine in scripts/ against
the affected worktree. Do not hand-edit gitlink entries.

diagnosis: ordinary file-level merge conflict in a group worktree — a
conflicts entry has a non-empty conflictedFilePaths.
solution: resolve each path listed in conflictedFilePaths inside that
worktree, keeping BOTH sides' intent, then stage only those paths and commit
the resolution.

diagnosis: dirty or half-merged worktree — the error mentions unmerged paths,
an unfinished merge, or a tree that is not clean.
solution: complete the in-progress merge if it can be completed, otherwise
abort it, so the tree is clean and this workflow can retry.

If none of them matches, identify the actual cause and fix it only when your
fix is as concrete and reversible as the three above.

Do not weaken, delete, or stub out code to make a conflict disappear, and do
not force-push or hard-reset anything you did not create. Do not run the merge
command yourself — this workflow runs it again once you report back.

Some blockers are not yours to decide: two sides changed the same logic in
ways that genuinely conflict, a recorded source branch is missing, or the only
way forward destroys work. You are not expected to resolve those, and
returning one is a correct outcome, not a failure. When you hit one:
  1. Stop working on it and leave the repo exactly as you found it.
  2. Add one entry to "decisions", phrased as the choice itself with the
     options you actually saw — for example "group-1 rewrote validateInput()
     while main deleted it: keep group-1's version, keep the deletion, or
     merge both?".
  3. Return the CASE B result below.
The caller shows each entry in "decisions" to the user as AskUserQuestion
choices, the user chooses, and the merge is retried with that answer. So write
each one so a human can answer it without opening the repo. Never pick for
them, and never guess.

Use "blockers" for the other kind: something that stopped you but that nobody
needs to decide — a tool that failed, a command you lacked permission to run,
a state you could not reach. One concrete sentence each.

Return one of exactly two results.

CASE A — you cleared every blocker and the merge can be retried. Return:
{"fixed": true, "summary": "<one sentence naming exactly what you changed>", "blockers": [], "decisions": []}

CASE B — you could not clear them. Return:
{"fixed": false, "summary": "<one sentence saying how far you got>", "blockers": [<one concrete sentence per non-decision failure>], "decisions": [<one question per choice that belongs to the user>]}`

const runMergeScript = (attempt) =>
  agent(runBrief, { label: `merge:run${attempt}`, phase: 'Merge', effort: 'low', schema: RUN_SCHEMA })

const MERGE_OK = 'OK'
const MERGE_FAILED = 'FAILED'

function mergeResultCode(run) {
  if (run === null || run === undefined) return MERGE_FAILED
  if (run.ok !== true) return MERGE_FAILED
  if ((run.conflicts?.length ?? 0) > 0) return MERGE_FAILED
  return MERGE_OK
}

log(`merging ${mergeCliInput.groups.length} group(s)`)
const firstMergeAttempt = await runMergeScript(1)

if (mergeResultCode(firstMergeAttempt) === MERGE_OK) {
  return { merged: firstMergeAttempt.merged, conflicts: [], fixedBlockers: null, blockers: [], decisions: [] }
}

log('merge failed — diagnosing')
const diagnosis = await agent(
  diagnoseBrief(firstMergeAttempt ?? { ok: false, conflicts: [], error: 'merge agent returned no result' }),
  { label: 'merge:unblock', phase: 'Unblock', schema: DIAGNOSE_SCHEMA },
)

const diagnosisMissing = diagnosis === null || diagnosis === undefined
const diagnosisFixed = diagnosisMissing ? false : diagnosis.fixed
const diagnosisSummary = diagnosisMissing
  ? 'the diagnosing agent returned no result, so nothing was diagnosed and nothing was fixed'
  : diagnosis.summary

if (diagnosisFixed === false) {
  return {
    merged: firstMergeAttempt?.merged ?? [],
    conflicts: firstMergeAttempt?.conflicts ?? [],
    fixedBlockers: false,
    blockers: diagnosisMissing ? ['the diagnosing agent returned no result'] : diagnosis.blockers,
    decisions: diagnosisMissing ? [] : diagnosis.decisions,
    summary: diagnosisSummary,
  }
}

log('blockers cleared — merging again')
const retry = await runMergeScript(2)
const retryFailed = mergeResultCode(retry) === MERGE_FAILED

return {
  merged: retry?.merged ?? [],
  conflicts: retry?.conflicts ?? [],
  fixedBlockers: true,
  blockers: retryFailed ? ['merge still failed after the fix; see conflicts and error'] : [],
  decisions: [],
  summary: diagnosisSummary,
  error: retry?.error ?? '',
}
