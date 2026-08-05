export const meta = {
  name: 'tackle-tasks-merge',
  description: 'Merge each approved group worktree back into the repo',
  phases: [{ title: 'Merge', detail: 'merge each group branch back into the repo' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args

const MERGE_SCHEMA = {
  type: 'object',
  properties: { merged: { type: 'array' }, conflicts: { type: 'array' } },
  required: ['merged', 'conflicts'],
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

log(`merging ${mergeCliInput.groups.length} group(s)`)

const mergeResult = await agent(
  `Run exactly this command and return its stdout as JSON, unmodified — do
not parse, summarize, reformat, or edit it. Do not run any other command.
Do not edit any file.

node "${ARGS.mergeScript}" '${JSON.stringify(mergeCliInput)}'`,
  { label: 'merge:repo', phase: 'Merge', effort: 'low', schema: MERGE_SCHEMA },
)

return {
  merged: mergeResult?.merged ?? [],
  conflicts: mergeResult?.conflicts ?? [],
}
