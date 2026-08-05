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
    testReceipts: { type: 'array' },
    reviewHandoffs: { type: 'array', items: { type: 'string' } },
    occurrenceDigests: { type: 'array', items: { type: 'string' } },
    runState: { type: ['object', 'null'] },
    publicationTargets: { type: 'array' },
    error: { type: 'string' },
  },
  required: ['ok', 'merged', 'conflicts', 'testReceipts', 'reviewHandoffs', 'occurrenceDigests', 'runState', 'publicationTargets', 'error'],
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
  repositoryManifest: ARGS.repositoryManifest,
  runId: ARGS.runId,
  startTimestamp: ARGS.startTimestamp,
  doneCount: ARGS.doneCount ?? 0,
  partialCount: ARGS.partialCount ?? 0,
  blockedCount: ARGS.blockedCount ?? 0,
  needsClarificationCount: ARGS.needsClarificationCount ?? 0,
  rejectedCount: ARGS.rejectedCount ?? 0,
  requeueCount: ARGS.requeueCount ?? 0,
  testReceipts: ARGS.testReceipts ?? [],
  reviewHandoffs: ARGS.reviewHandoffs ?? [],
}

const command = `node "${ARGS.mergeScript}" '${JSON.stringify(mergeCliInput)}'`

const runBrief = `Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

result = run(${command})

if result.exitCode == 0 and result.stdout is JSON containing "merged" and "conflicts":
    return {ok: true, merged: result.stdout.merged, conflicts: result.stdout.conflicts, testReceipts: result.stdout.testReceipts, reviewHandoffs: result.stdout.reviewHandoffs, occurrenceDigests: result.stdout.occurrenceDigests, runState: result.stdout.runState, publicationTargets: result.stdout.publicationTargets, error: ""}
else:
    return {ok: false, merged: [], conflicts: [], testReceipts: [], reviewHandoffs: [], occurrenceDigests: [], runState: null, publicationTargets: [], error: result.exitCode + ": " + (result.stderr or result.stdout)}

You are forbidden to edit any file, to run any other command, or to change the
merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, or
publicationTargets values on the success branch.`

const diagnoseBrief = (run) => `The merge failed.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

repo = ${ARGS.repo}
failedCommand = ${command}
report = ${JSON.stringify({ ok: run.ok, conflicts: run.conflicts ?? [], error: run.error ?? '' })}

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
  return {
    merged: firstMergeAttempt.merged,
    conflicts: [],
    testReceipts: firstMergeAttempt.testReceipts,
    reviewHandoffs: firstMergeAttempt.reviewHandoffs,
    occurrenceDigests: firstMergeAttempt.occurrenceDigests,
    runState: firstMergeAttempt.runState,
    publicationTargets: firstMergeAttempt.publicationTargets,
    fixedBlockers: null,
    blockers: [],
    decisions: [],
  }
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

// A pending decision blocks the retry even when the agent reported fixed.
const decisionsPending = diagnosisMissing ? false : (diagnosis.decisions?.length ?? 0) > 0

if (diagnosisFixed === false || decisionsPending === true) {
  return {
    merged: firstMergeAttempt?.merged ?? [],
    conflicts: firstMergeAttempt?.conflicts ?? [],
    testReceipts: firstMergeAttempt?.testReceipts ?? [],
    reviewHandoffs: firstMergeAttempt?.reviewHandoffs ?? [],
    occurrenceDigests: [],
    runState: null,
    publicationTargets: [],
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
  testReceipts: retry?.testReceipts ?? [],
  reviewHandoffs: retry?.reviewHandoffs ?? [],
  occurrenceDigests: retryFailed ? [] : (retry?.occurrenceDigests ?? []),
  runState: retryFailed ? null : (retry?.runState ?? null),
  publicationTargets: retryFailed ? [] : (retry?.publicationTargets ?? []),
  fixedBlockers: true,
  blockers: retryFailed ? ['merge still failed after the fix; see conflicts and error'] : [],
  decisions: [],
  summary: diagnosisSummary,
  error: retry?.error ?? '',
}
