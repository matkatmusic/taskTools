const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const N = ARGS.task
const STAGE = ARGS.stage ?? 'plan+implement'
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
// Unlike TYPECHECK_COMMAND (brief-text display default), an unconfigured rebase-test must skip typecheck, not silently run one.
const REBASE_TYPECHECK_COMMAND = ARGS.typecheckCommand ?? null
const WORKER_MODEL = ARGS.workerModel
const MAX_FIX_ROUNDS = ARGS.maxRounds ?? 3
const MAX_REBASE_FIX_ROUNDS = ARGS.maxRebaseFixRounds ?? 3
const WORKTREE = ARGS.worktree
if (!WORKTREE) throw new Error('tackle-tasks.workflow.js: no "worktree" in args; every stage must run inside the prepared task worktree')
const SOURCE_ROOT = ARGS.sourceRoot
if (!SOURCE_ROOT) throw new Error('tackle-tasks.workflow.js: no "sourceRoot" in args')
const EMITTER_PATH = ARGS.agentPromptEmitterPath
if (!EMITTER_PATH) throw new Error('tackle-tasks.workflow.js: no "agentPromptEmitterPath" in args; the skill-body emitter must supply it')
const REPOSITORY_MANIFEST = ARGS.repositoryManifest

export const meta = {
  name: `task-${N}`,
  description: 'Run one task through its stage pipeline (plan / implement / rebase-test / merge)',
  phases: [
    { title: `${N} Plan`, detail: 'write and refine the task plan' },
    { title: `${N} Implement`, detail: 'implement the plan and check the file fence' },
    { title: `${N} Rebase-Test`, detail: 'rebase onto source and run the full suite' },
    { title: `${N} Merge`, detail: 'merge and close the task' },
    { title: `${N} Cleanup`, detail: 'retry final worktree/branch/persistence cleanup after a cleanup-incomplete merge' },
  ],
}

// Emitter role contract: plans/task-86-agent-prompt-fixtures/emitter-role-contract.md

// worktree/sourceRoot/runId ride on every call: the emitter has no cwd guarantee and no other way to recover them.
const emitterInstruction = (role, extra = {}) => {
  const payload = { worktree: WORKTREE, sourceRoot: SOURCE_ROOT, runId: ARGS.runId, ...extra }
  return `Run exactly this command:
\`\`\`
node ${EMITTER_PATH} ${N} ${role} <<'TT_PAYLOAD'
${JSON.stringify(payload)}
TT_PAYLOAD
\`\`\`
Follow the printed instructions.`
}

const TASK_INFO_SCHEMA = {
  type: 'object',
  properties: {
    planFile: { type: 'string' },
    notesFile: { type: 'string' },
    briefFile: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    tests: { type: ['string', 'null'] },
  },
  required: ['planFile', 'notesFile', 'briefFile', 'files'],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    status: { type: 'string', enum: ['planned', 'needs-clarification', 'not-relevant'] },
    planFile: { type: 'string' },
    question: { type: 'string' },
    missingFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['task', 'status', 'planFile', 'question'],
}

const WIDEN_FILES_SCHEMA = {
  type: 'object',
  properties: { files: { type: 'array', items: { type: 'string' } } },
  required: ['files'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    notes: { type: 'string' },
    reviewer: { type: 'string', enum: ['codex', 'claude'] },
    missingFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['task', 'verdict', 'notes', 'reviewer'],
}

const APPLY_FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    applied: { type: 'boolean' },
  },
  required: ['task', 'applied'],
}

const GIT_HEAD_SCHEMA = {
  type: 'object',
  properties: { oid: { type: 'string' } },
  required: ['oid'],
}

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    remaining: { type: 'array', items: { type: 'string' } },
    notesFile: { type: 'string' },
  },
  required: ['task', 'status', 'summary', 'remaining', 'notesFile'],
}

const IMPLEMENT_FINALIZE_SCHEMA = {
  type: 'object',
  properties: {
    headOid: { type: 'string' },
    changedPaths: { type: 'array', items: { type: 'string' } },
  },
  required: ['headOid', 'changedPaths'],
}

const OCCURRENCE_OIDS_SCHEMA = {
  type: 'object',
  properties: {
    oids: { type: 'object' },
  },
  required: ['oids'],
}

const REBASE_WALK_SCHEMA = {
  type: 'object',
  properties: {
    stoppedAt: {
      type: ['object', 'null'],
      properties: {
        status: { type: 'string' },
        occurrenceId: { type: 'string' },
        checkoutPath: { type: 'string' },
        conflictedFilePaths: { type: 'array', items: { type: 'string' } },
        testOutput: { type: 'string' },
        failedCheck: { type: 'string' },
      },
    },
  },
  required: ['stoppedAt'],
}

const MERGE_CONFLICT_SCHEMA = {
  type: 'object',
  properties: {
    resolved: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['resolved', 'summary'],
}

const ADVANCE_CONFLICT_SCHEMA = {
  type: 'object',
  properties: {
    advanced: { type: 'boolean' },
    lastFailure: { type: ['string', 'null'] },
    cleanupFailure: { type: ['string', 'null'] },
    touchedPaths: {
      type: 'array',
      items: {
        type: 'object',
        properties: { occurrenceId: { type: 'string' }, path: { type: 'string' } },
        required: ['occurrenceId', 'path'],
      },
    },
  },
  required: ['advanced', 'lastFailure', 'cleanupFailure', 'touchedPaths'],
}

const REBASE_FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['fixed', 'summary'],
}

const REBASE_FIX_VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    ownCheckoutClean: { type: 'boolean' },
    touchedPaths: {
      type: 'array',
      items: {
        type: 'object',
        properties: { occurrenceId: { type: 'string' }, path: { type: 'string' } },
        required: ['occurrenceId', 'path'],
      },
    },
  },
  required: ['ownCheckoutClean', 'touchedPaths'],
}

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    failedAtStage: { type: ['string', 'null'] },
    mergedCommitHash: { type: ['string', 'null'] },
    closed: { type: 'array', items: { type: 'integer' } },
    skipped: { type: 'array', items: { type: 'integer' } },
    unblocked: { type: 'array', items: { type: 'integer' } },
    closeError: { type: ['string', 'null'] },
    cleanupWarning: { type: ['string', 'null'] },
    lastFailure: { type: ['string', 'null'] },
    conflictedFilePaths: { type: 'array', items: { type: 'string' } },
    occurrenceId: { type: ['string', 'null'] },
    retainedArtifacts: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
}

const CLEANUP_ONLY_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    cleanupWarning: { type: ['string', 'null'] },
    retainedArtifacts: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
}

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

const MAX_REVIEW_ROUNDS = 3

// occurrenceId -> checkout path in THIS worktree, never the source manifest's checkoutPath.
const joinPath = (a, b) => `${a.replace(/\/+$/, '')}/${b}`

const taskWorktreeCheckoutPaths = (occurrences, worktreePath) => {
  const byId = new Map(occurrences.map((o) => [o.occurrenceId, o]))
  const resolved = new Map()
  const resolve = (occurrenceId) => {
    if (resolved.has(occurrenceId)) return resolved.get(occurrenceId)
    const occurrence = byId.get(occurrenceId)
    const checkoutPath = occurrence.parentOccurrenceId === null
      ? worktreePath
      : joinPath(resolve(occurrence.parentOccurrenceId), occurrence.pathInParent)
    resolved.set(occurrenceId, checkoutPath)
    return checkoutPath
  }
  for (const occurrence of occurrences) resolve(occurrence.occurrenceId)
  return resolved
}

// A parent's checkoutPath contains every submodule's checkoutPath; exclude those nested layers explicitly.
const isDescendantPath = (parent, child) => {
  const p = parent.replace(/\/+$/, '')
  return child !== p && child.startsWith(`${p}/`)
}

const pathsFor = (checkoutPaths, occurrenceIds) => Object.fromEntries(occurrenceIds.map((id) => [id, checkoutPaths.get(id)]))

const fetchOccurrenceOids = async (checkoutPaths, occurrenceIds) => {
  const result = await retryAgent(() => agent(emitterInstruction('occurrence-oids', { checkoutPaths: pathsFor(checkoutPaths, occurrenceIds) }), { label: `occurrence-oids:${N}`, schema: OCCURRENCE_OIDS_SCHEMA })) ?? { oids: {} }
  return result.oids
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

const fetchTaskInfo = () => retryAgent(() => agent(emitterInstruction('task-info'), { label: `task-info:${N}`, schema: TASK_INFO_SCHEMA }))

// A planner that reports "planned" without writing the expected task-worktree plan file never wrote a plan.
const rejectPlannedWithoutExpectedPlanFile = async (planResult, expectedPlanFile) => {
  if (planResult.status !== 'planned') return planResult
  if (planResult.planFile !== expectedPlanFile) {
    return {
      ...planResult,
      status: 'needs-clarification',
      planFile: expectedPlanFile,
      question:
        `planner reported status "planned" with an unexpected plan path: ${planResult.planFile}, expected ${expectedPlanFile}`,
    }
  }
  return planResult
}

const runPlan = async () => {
  log(`task ${N}: plan stage`)
  let preparedTask = await fetchTaskInfo()
  if (!preparedTask) throw new Error(`tackle-tasks.workflow.js: task-info returned no result for task ${N}`)

  const runPlanAgent = (preamble) => retryAgent(() => agent(emitterInstruction('plan', preamble ? { preamble } : {}), { label: `plan:${N}`, phase: `${N} Plan`, schema: PLAN_SCHEMA }))

  const result = await runPlanAgent()
  let planResult = {
    stage: 'plan',
    ...(result ?? {
      task: N,
      status: 'needs-clarification',
      planFile: '',
      question: 'planner returned no result after 3 attempts',
    }),
  }
  planResult.files = preparedTask.files
  planResult = await rejectPlannedWithoutExpectedPlanFile(planResult, preparedTask.planFile)
  if (planResult.status !== 'planned') return planResult

  const runVerify = async () => await retryAgent(() => agent(emitterInstruction('verify'), { label: `verify:${N}`, phase: `${N} Plan`, schema: VERIFY_SCHEMA })) ?? {
    task: N,
    verdict: 'rejected',
    notes: 'verifier agent returned no result after 3 attempts (killed, errored, or blocked)',
    reviewer: 'none',
    missingFiles: [],
  }

  const widenFilesAndReplan = async (missingFiles) => {
    const widened = await retryAgent(() => agent(emitterInstruction('widen-files', { missingFiles }), { label: `widen-files:${N}`, phase: `${N} Plan`, schema: WIDEN_FILES_SCHEMA }))
    if (!widened) throw new Error(`tackle-tasks.workflow.js: widen-files returned no result for task ${N}`)
    preparedTask = { ...preparedTask, files: widened.files }
    const fileRetryPreamble = `Before planning: the workflow has already widened this task's owned files in tasks.json to include ${missingFiles.join(', ')} and regenerated the brief file — you do not need to run any command for this. The owned-files list below already includes the paths you previously flagged as missing.\n\n`
    const rePlanned = await runPlanAgent(fileRetryPreamble)
    planResult = {
      stage: 'plan',
      ...(rePlanned ?? {
        task: N,
        status: 'needs-clarification',
        planFile: '',
        question: 'planner returned no result after 3 attempts',
      }),
    }
    planResult.files = preparedTask.files
    planResult = await rejectPlannedWithoutExpectedPlanFile(planResult, preparedTask.planFile)
  }

  let reviewRounds = MAX_REVIEW_ROUNDS
  let verify = await runVerify()
  reviewRounds -= 1
  while (verify.verdict !== 'approved' && reviewRounds > 0) {
    if (Array.isArray(verify.missingFiles) && verify.missingFiles.length > 0) {
      await widenFilesAndReplan(verify.missingFiles)
      if (planResult.status !== 'planned') return planResult
    } else {
      await retryAgent(() => agent(emitterInstruction('apply-feedback', { notes: verify.notes }), { label: `applyFeedback:${N}`, phase: `${N} Plan`, schema: APPLY_FEEDBACK_SCHEMA }))
    }
    verify = await runVerify()
    reviewRounds -= 1
  }
  return { ...planResult, verify, reviewRounds }
}

// ---------------------------------------------------------------------------
// Implement
// ---------------------------------------------------------------------------

const runWorker = (note) => {
  const options = {
    label: `implement:${N}`,
    phase: `${N} Implement`,
    schema: WORKER_SCHEMA,
  }
  if (WORKER_MODEL) options.model = WORKER_MODEL
  const payload = { typecheckCommand: TYPECHECK_COMMAND, maxFixRounds: MAX_FIX_ROUNDS, ...(note ? { note } : {}) }
  return retryAgent(() => agent(emitterInstruction('implement', payload), options))
}

const runImplement = async () => {
  log(`task ${N}: implement stage`)
  const preparedTask = await fetchTaskInfo()
  if (!preparedTask) throw new Error(`tackle-tasks.workflow.js: task-info returned no result for task ${N}`)

  const baseHead = await retryAgent(() => agent(emitterInstruction('git-head'), { label: `git-head:${N}`, phase: `${N} Implement`, schema: GIT_HEAD_SCHEMA }))
  const base = baseHead?.oid ?? ''

  let result = await runWorker('') ?? {
    task: N,
    status: 'blocked',
    summary: 'worker agent returned no result after 3 attempts (killed, errored, or blocked)',
    remaining: [],
    notesFile: preparedTask.notesFile,
  }
  if (result.status === 'partial') {
    const note = `A previous worker finished part of this plan; still remaining: ${result.remaining.join('; ')}. Check the file state before redoing anything.`
    result = (await runWorker(note)) ?? result
  }

  const finalized = await retryAgent(() => agent(emitterInstruction('implement-finalize', { baseOid: base }), { label: `implement-finalize:${N}`, phase: `${N} Implement`, schema: IMPLEMENT_FINALIZE_SCHEMA })) ?? { headOid: base, changedPaths: [] }

  if (result.status === 'done' && finalized.headOid === base) {
    result = {
      ...result,
      status: 'blocked',
      summary: 'implementer reported done but made no commit in taskWorktree',
      remaining: ['commit the implementation in the prepared task worktree'],
    }
  }

  const notesRelative = preparedTask.notesFile.slice(WORKTREE.length + 1)
  const fenceViolations = finalized.changedPaths.filter(
    (p) => p !== notesRelative && !preparedTask.files.includes(p),
  )
  return { stage: 'implement', ...result, files: preparedTask.files, fenceViolations }
}

// ---------------------------------------------------------------------------
// Rebase-test
// ---------------------------------------------------------------------------

const runMergeConflictAgent = (checkoutPath, conflictedFilePaths) => retryAgent(() => agent(
  emitterInstruction('merge-conflict', { checkoutPath, conflictedFilePaths }),
  { label: `rebase-conflict:${N}`, phase: `${N} Rebase-Test`, schema: MERGE_CONFLICT_SCHEMA },
))

const runRebaseFixAgent = (checkoutPath, occurrenceId, testOutput, forbiddenPaths) => retryAgent(() => agent(
  emitterInstruction('rebase-fix', { checkoutPath, occurrenceId, testOutput, forbiddenPaths }),
  { label: `rebase-fix:${N}`, phase: `${N} Rebase-Test`, schema: REBASE_FIX_SCHEMA },
))

// Resolves one conflict: the LLM edits+stages, then a deterministic driver commits cross-layer edits and drives continue/abort.
const advanceLiveConflict = async (checkoutPaths, occurrencesDeepestFirst, activeOccurrenceId, conflictedFilePaths, fenceViolations) => {
  const conflictSummary = `unresolved merge conflict in ${activeOccurrenceId || 'root'}; unresolved paths: ${conflictedFilePaths.join(', ')}`
  const otherOccurrenceIds = occurrencesDeepestFirst.map((o) => o.occurrenceId).filter((id) => id !== activeOccurrenceId)
  const beforeOids = await fetchOccurrenceOids(checkoutPaths, otherOccurrenceIds)

  const checkoutPath = checkoutPaths.get(activeOccurrenceId)
  const result = await runMergeConflictAgent(checkoutPath, conflictedFilePaths)
  const resolved = result != null && result.resolved === true

  const advanced = await retryAgent(() => agent(
    emitterInstruction('advance-conflict', {
      occurrenceId: activeOccurrenceId,
      conflictedFilePaths,
      resolved,
      beforeOids,
      checkoutPaths: pathsFor(checkoutPaths, [activeOccurrenceId, ...otherOccurrenceIds]),
    }),
    { label: `advance-conflict:${N}`, phase: `${N} Rebase-Test`, schema: ADVANCE_CONFLICT_SCHEMA },
  ))
  if (!advanced) return { advanced: false, lastFailure: conflictSummary, cleanupFailure: 'advance-conflict driver returned no result after 3 attempts' }
  for (const touched of advanced.touchedPaths) fenceViolations.push(touched)
  return advanced
}

// Verifies a fix attempt before any rebase/test cycle re-runs: unfixed, dirty, or another layer touched all fail.
const attemptRebaseFix = async (checkoutPaths, occurrencesDeepestFirst, occurrenceId, checkoutPath, testOutput, forbiddenPaths, fenceViolations) => {
  const otherOccurrenceIds = occurrencesDeepestFirst.map((o) => o.occurrenceId).filter((id) => id !== occurrenceId)
  const beforeOids = await fetchOccurrenceOids(checkoutPaths, otherOccurrenceIds)
  const fixOutcome = await runRebaseFixAgent(checkoutPath, occurrenceId, testOutput, forbiddenPaths)
  const verify = await retryAgent(() => agent(
    emitterInstruction('rebase-fix-verify', { checkoutPath, occurrenceId, beforeOids, checkoutPaths: pathsFor(checkoutPaths, otherOccurrenceIds) }),
    { label: `rebase-fix-verify:${N}`, phase: `${N} Rebase-Test`, schema: REBASE_FIX_VERIFY_SCHEMA },
  )) ?? { ownCheckoutClean: false, touchedPaths: [] }
  for (const touched of verify.touchedPaths) fenceViolations.push(touched)
  return fixOutcome != null && fixOutcome.fixed === true && verify.ownCheckoutClean && verify.touchedPaths.length === 0
}

const runRebaseTest = async () => {
  log(`task ${N}: rebase-test stage`)
  const occurrences = REPOSITORY_MANIFEST.occurrences
  const rootOccurrence = occurrences.find((o) => o.occurrenceId === '')
  const sourceBranch = rootOccurrence.baseBranch
  const checkoutPaths = taskWorktreeCheckoutPaths(occurrences, WORKTREE)
  const occurrencesDeepestFirst = [...occurrences].sort((a, b) => b.depth - a.depth)
  const fenceViolations = []
  const fixRoundsByOccurrenceId = new Map()
  const consumeFixRound = (occurrenceId) => {
    const used = (fixRoundsByOccurrenceId.get(occurrenceId) ?? 0) + 1
    fixRoundsByOccurrenceId.set(occurrenceId, used)
    return used
  }
  const descendantCheckoutPaths = (occurrenceId) => {
    const ownPath = checkoutPaths.get(occurrenceId)
    return occurrencesDeepestFirst
      .filter((o) => o.occurrenceId !== occurrenceId)
      .map((o) => checkoutPaths.get(o.occurrenceId))
      .filter((path) => isDescendantPath(ownPath, path))
  }

  const walk = (role) => retryAgent(() => agent(
    emitterInstruction(role, { repositoryManifest: REPOSITORY_MANIFEST, typecheckCommand: REBASE_TYPECHECK_COMMAND }),
    { label: `${role}:${N}`, phase: `${N} Rebase-Test`, schema: REBASE_WALK_SCHEMA },
  ))

  let layerWalk = await walk('rebase-walk')
  if (!layerWalk) throw new Error(`tackle-tasks.workflow.js: rebase-walk returned no result for task ${N}`)
  while (layerWalk.stoppedAt !== null && (layerWalk.stoppedAt.status === 'conflicted' || layerWalk.stoppedAt.status === 'tests-failed')) {
    const stopped = layerWalk.stoppedAt
    if (stopped.status === 'conflicted') {
      const { occurrenceId, conflictedFilePaths } = stopped
      const outcome = await advanceLiveConflict(checkoutPaths, occurrencesDeepestFirst, occurrenceId, conflictedFilePaths, fenceViolations)
      if (!outcome.advanced) {
        return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: outcome.lastFailure, cleanupFailure: outcome.cleanupFailure, occurrenceId, fenceViolations }
      }
    } else {
      const { occurrenceId, checkoutPath, testOutput } = stopped
      let fixSucceeded = false
      while (!fixSucceeded) {
        if (consumeFixRound(occurrenceId) > MAX_REBASE_FIX_ROUNDS) {
          return {
            stage: 'rebase-test', task: N, status: 'blocked',
            lastFailure: `${stopped.failedCheck} still red after MAX_REBASE_FIX_ROUNDS`,
            failedCheck: stopped.failedCheck,
            occurrenceId, fenceViolations,
          }
        }
        fixSucceeded = await attemptRebaseFix(checkoutPaths, occurrencesDeepestFirst, occurrenceId, checkoutPath, testOutput, descendantCheckoutPaths(occurrenceId), fenceViolations)
      }
    }
    layerWalk = await walk('rebase-walk')
    if (!layerWalk) throw new Error(`tackle-tasks.workflow.js: rebase-walk returned no result for task ${N}`)
  }
  if (layerWalk.stoppedAt !== null) {
    const stopped = layerWalk.stoppedAt
    const lastFailure = stopped.status === 'untested' ? 'untested layer' : stopped.status
    return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure, occurrenceId: stopped.occurrenceId, layerOutcome: stopped, fenceViolations }
  }

  let parentOutcome = await walk('parent-rebase')
  if (!parentOutcome) throw new Error(`tackle-tasks.workflow.js: parent-rebase returned no result for task ${N}`)
  let parentStopped = parentOutcome.stoppedAt
  while (parentStopped !== null && (parentStopped.status === 'conflicted' || parentStopped.status === 'tests-failed')) {
    if (parentStopped.status === 'conflicted') {
      const outcome = await advanceLiveConflict(checkoutPaths, occurrencesDeepestFirst, '', parentStopped.conflictedFilePaths, fenceViolations)
      if (!outcome.advanced) {
        return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: outcome.lastFailure, cleanupFailure: outcome.cleanupFailure, occurrenceId: '', fenceViolations }
      }
    } else {
      let fixSucceeded = false
      while (!fixSucceeded) {
        if (consumeFixRound('') > MAX_REBASE_FIX_ROUNDS) {
          return {
            stage: 'rebase-test', task: N, status: 'blocked',
            lastFailure: `${parentStopped.failedCheck} still red after MAX_REBASE_FIX_ROUNDS`,
            failedCheck: parentStopped.failedCheck,
            occurrenceId: '', fenceViolations,
          }
        }
        fixSucceeded = await attemptRebaseFix(checkoutPaths, occurrencesDeepestFirst, '', WORKTREE, parentStopped.testOutput, [], fenceViolations)
      }
    }
    parentOutcome = await walk('parent-rebase')
    if (!parentOutcome) throw new Error(`tackle-tasks.workflow.js: parent-rebase returned no result for task ${N}`)
    parentStopped = parentOutcome.stoppedAt
  }
  if (parentStopped !== null) {
    const lastFailure = parentStopped.status === 'untested' ? 'untested layer' : parentStopped.status
    return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure, occurrenceId: '', parentOutcome: parentStopped, fenceViolations }
  }

  return { stage: 'rebase-test', task: N, status: 'green', fenceViolations, sourceBranch }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const runMerge = async () => {
  log(`task ${N}: merge stage`)
  const rootOccurrence = REPOSITORY_MANIFEST.occurrences.find((o) => o.occurrenceId === '')
  if (rootOccurrence.checkoutPath !== SOURCE_ROOT) {
    throw new Error(`tackle-tasks.workflow.js: repositoryManifest root checkoutPath (${rootOccurrence.checkoutPath}) does not match sourceRoot (${SOURCE_ROOT})`)
  }
  const report = await retryAgent(() => agent(
    emitterInstruction('merge', { repositoryManifest: REPOSITORY_MANIFEST }),
    { label: `merge:${N}`, phase: `${N} Merge`, schema: MERGE_SCHEMA },
  ))
  if (!report) {
    return { stage: 'merge', task: N, status: 'blocked', lastFailure: 'merge driver returned no result after 3 attempts' }
  }
  return { stage: 'merge', task: N, ...report }
}

// Retries only final cleanup after a 'cleanup-incomplete' merge result; never re-merges or re-closes.
const runCleanupOnly = async () => {
  log(`task ${N}: cleanup-only stage`)
  const report = await retryAgent(() => agent(
    emitterInstruction('cleanup-only', { repositoryManifest: REPOSITORY_MANIFEST }),
    { label: `cleanup-only:${N}`, phase: `${N} Cleanup`, schema: CLEANUP_ONLY_SCHEMA },
  ))
  if (!report) {
    return { stage: 'cleanup-only', task: N, status: 'cleanup-incomplete', cleanupWarning: 'cleanup-only driver returned no result after 3 attempts' }
  }
  return { stage: 'cleanup-only', task: N, ...report }
}

// ---------------------------------------------------------------------------
// Stage dispatch
// ---------------------------------------------------------------------------

const STAGE_RUNNERS = {
  plan: async () => [await runPlan()],
  implement: async () => [await runImplement()],
  'rebase-test': async () => [await runRebaseTest()],
  merge: async () => [await runMerge()],
  'cleanup-only': async () => [await runCleanupOnly()],
  'plan+implement': async () => {
    const planResult = await runPlan()
    if (planResult.status !== 'planned') return [planResult]
    return [planResult, await runImplement()]
  },
}

const runner = STAGE_RUNNERS[STAGE]
if (!runner) throw new Error(`tackle-tasks.workflow.js: unknown stage "${STAGE}"`)

return { task: N, stage: STAGE, results: await runner() }
