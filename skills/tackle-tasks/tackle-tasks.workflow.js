export const meta = {
  name: 'tackle-task',
  description: 'Drive one task from validation to merge, per plans/diagram/pipeline.mmd',
  phases: [
    { title: 'Preflight', detail: 'validate the number, claim the task, check blockers' },
    { title: 'Worktree', detail: 'create, reset or adopt the task worktree' },
    { title: 'Plan', detail: 'write the plan, review it, apply amendments' },
    { title: 'Implement', detail: 'implement the plan and record its notes' },
    { title: 'Test', detail: 'run the task tests and review them' },
    { title: 'Rebase', detail: 'lock the source repo and rebase onto the target branch' },
    { title: 'Suite', detail: 'run the full suite' },
    { title: 'Merge', detail: 'check the file fence and merge' },
    { title: 'Close', detail: 'record, clean up and archive' },
  ],
}

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const N = ARGS.task
const PROJECT_ROOT = ARGS.projectRoot
const SOURCE_BRANCH = ARGS.sourceBranch
const RUN_ID = ARGS.runId
const SCRIPTS_DIR = ARGS.scriptsDir
const EMITTER_PATH = ARGS.agentPromptEmitterPath

if (!Number.isInteger(N)) throw new Error('tackle-tasks.workflow.js: args.task must be a task number')
if (!PROJECT_ROOT) throw new Error('tackle-tasks.workflow.js: args.projectRoot is required')
if (!SOURCE_BRANCH) throw new Error('tackle-tasks.workflow.js: args.sourceBranch is required')
if (!RUN_ID) throw new Error('tackle-tasks.workflow.js: args.runId is required')
if (!SCRIPTS_DIR) throw new Error('tackle-tasks.workflow.js: args.scriptsDir is required')
if (!EMITTER_PATH) throw new Error('tackle-tasks.workflow.js: args.agentPromptEmitterPath is required')

// Diagram rule: every repair loop is capped at two attempts.
const MAX_REPAIR_ATTEMPTS = 2
// A read-only box may be re-spawned, because re-reading the world changes nothing.
const READ_ONLY_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

let worktree = null
let branchName = null
let claimed = false
let runEnded = false

let planScraps = 0
let testFixes = 0
let testAmendments = 0
let conflictFixes = 0
let suiteFixes = 0
let mergeAttempts = 0

// ponytail: one payload base with both spellings of the worktree and the source branch.
// The scripts disagree on the key names and ignore the keys they do not read.
const base = () => ({
  taskNumber: N,
  projectRoot: PROJECT_ROOT,
  runId: RUN_ID,
  expectedRunId: RUN_ID,
  worktree,
  worktreePath: worktree,
  sourceBranch: SOURCE_BRANCH,
  rootSourceBranch: SOURCE_BRANCH,
})

const planFilePath = () => worktree + '/plans/plan.json'
const reviewFilePath = () => worktree + '/plans/codex-review.json'

// A logical step id per diagram-box visit. It survives reconciliation; a later visit gets a new one.
const stepVisits = {}
const nextStepId = (box) => {
  stepVisits[box] = (stepVisits[box] || 0) + 1
  return box + ':' + stepVisits[box]
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const STRINGS = { type: 'array', items: { type: 'string' } }
const NULLABLE_STRING = { type: ['string', 'null'] }
const STOPPED_AT = {
  type: ['object', 'null'],
  properties: { occurrenceId: { type: 'string' }, checkoutPath: { type: 'string' } },
}
const COMMITS = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      occurrenceId: { type: 'string' },
      hash: { type: 'string' },
      kind: { type: 'string', enum: ['work', 'repair', 'merge'] },
      stepId: { type: 'string' },
    },
  },
}

const NUMBER_VALID_SCHEMA = { type: 'object', properties: { valid: { type: 'boolean' }, location: NULLABLE_STRING }, required: ['valid'] }
const TASK_OPEN_SCHEMA = { type: 'object', properties: { open: { type: 'boolean' }, closeInProgress: { type: 'boolean' } }, required: ['open'] }
const CLAIM_SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['claimed', 'refused', 'closing', 'not-found'] }, heldByRunId: NULLABLE_STRING },
  required: ['status'],
}
const BLOCKED_SCHEMA = {
  type: 'object',
  properties: {
    blocked: { type: 'boolean' },
    blockers: { type: 'array', items: { type: 'object', properties: { taskNum: { type: 'number' }, reason: { type: 'string' } } } },
  },
  required: ['blocked'],
}
const WORKTREE_EXISTS_SCHEMA = { type: 'object', properties: { exists: { type: 'boolean' }, worktree: NULLABLE_STRING }, required: ['exists'] }
const WORKTREE_SCHEMA = { type: 'object', properties: { worktree: { type: 'string' }, branch: { type: 'string' } }, required: ['worktree', 'branch'] }
const WORKTREE_SAFE_SCHEMA = { type: 'object', properties: { safe: { type: 'boolean' }, problems: STRINGS }, required: ['safe'] }
const RESUMABLE_SCHEMA = {
  type: 'object',
  properties: { resumable: { type: 'boolean' }, implementationNotesFile: NULLABLE_STRING, leaseEstablished: { type: 'boolean' } },
  required: ['resumable', 'leaseEstablished'],
}
const BRIEF_SCHEMA = { type: 'object', properties: { briefFile: { type: 'string' } }, required: ['briefFile'] }
const AMEND_BRIEF_SCHEMA = { type: 'object', properties: { briefFile: { type: 'string' }, runsAmended: { type: 'number' } }, required: ['briefFile'] }
const SUBMODULES_SCHEMA = { type: 'object', properties: { initialized: { type: 'boolean' } }, required: ['initialized'] }
const PLAN_VALID_SCHEMA = { type: 'object', properties: { valid: { type: 'boolean' }, problem: NULLABLE_STRING, sectionIds: STRINGS }, required: ['valid'] }
const REVIEW_VALID_SCHEMA = {
  type: 'object',
  properties: {
    valid: { type: 'boolean' },
    problem: NULLABLE_STRING,
    verdict: { type: ['string', 'null'], enum: ['amend', 'scrap', null] },
    scrapNotes: NULLABLE_STRING,
  },
  required: ['valid'],
}
const AMENDMENTS_SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['applied', 'rejected'] }, revision: { type: 'number' }, problem: NULLABLE_STRING },
  required: ['status'],
}
const NOTES_SCHEMA = { type: 'object', properties: { implementationNotesFile: { type: 'string' } }, required: ['implementationNotesFile'] }
const COMMIT_SCHEMA = { type: 'object', properties: { commits: COMMITS }, required: ['commits'] }
const TASK_TESTS_SCHEMA = {
  type: 'object',
  properties: {
    stepId: { type: 'string' },
    passed: { type: 'boolean' },
    testFiles: STRINGS,
    createdTestFiles: STRINGS,
    deletedTestFiles: STRINGS,
    missingTests: { type: 'boolean' },
    output: { type: 'string' },
  },
  required: ['passed'],
}
const FULL_SUITE_SCHEMA = {
  type: 'object',
  properties: {
    stepId: { type: 'string' },
    passed: { type: 'boolean' },
    layers: { type: 'array', items: { type: 'object', properties: { occurrenceId: { type: 'string' }, passed: { type: 'boolean' } } } },
    output: { type: 'string' },
  },
  required: ['passed'],
}
const REBASE_SCHEMA = {
  type: 'object',
  properties: {
    lock: { type: 'string', enum: ['acquired', 'held', 'recoverable'] },
    heldByOwner: NULLABLE_STRING,
    recoveryCommand: NULLABLE_STRING,
    conflicted: { type: 'boolean' },
    stoppedAt: STOPPED_AT,
    conflictedFilePaths: STRINGS,
    failureReason: NULLABLE_STRING,
  },
  required: ['lock', 'conflicted'],
}
const ADVANCE_SCHEMA = {
  type: 'object',
  properties: {
    finished: { type: 'boolean' },
    conflicted: { type: 'boolean' },
    stoppedAt: STOPPED_AT,
    conflictedFilePaths: STRINGS,
    failureReason: NULLABLE_STRING,
  },
  required: ['finished', 'conflicted'],
}
const FENCE_SCHEMA = { type: 'object', properties: { inside: { type: 'boolean' }, violations: STRINGS }, required: ['inside'] }
const MERGE_SCHEMA = {
  type: 'object',
  properties: { merged: { type: 'boolean' }, commits: COMMITS, failureReason: NULLABLE_STRING },
  required: ['merged'],
}
const MERGE_COMMITS_SCHEMA = { type: 'object', properties: { commits: COMMITS }, required: ['commits'] }
const EXIT_NOTES_SCHEMA = { type: 'object', properties: { exitType: { type: 'string' }, exitNote: { type: 'string' } }, required: ['exitType'] }
const MODIFIED_FILES_SCHEMA = { type: 'object', properties: { modifiedFiles: STRINGS }, required: ['modifiedFiles'] }
const INACTIVE_SCHEMA = { type: 'object', properties: { active: { type: 'boolean' }, endedAt: { type: 'string' } }, required: ['active'] }
const HOLDS_SCHEMA = {
  type: 'object',
  properties: { leaseReleased: { type: 'boolean' }, leaseRetained: { type: 'boolean' }, lockReleased: { type: 'boolean' } },
  required: ['leaseReleased', 'lockReleased'],
}
const CLEANUP_SCHEMA = { type: 'object', properties: { removed: { type: 'boolean' }, retainedArtifacts: STRINGS }, required: ['removed'] }
const CLOSURE_NOTE_SCHEMA = { type: 'object', properties: { closureNote: { type: 'string' } }, required: ['closureNote'] }
const CLOSE_SCHEMA = {
  type: 'object',
  properties: {
    closed: { type: 'array', items: { type: 'number' } },
    skipped: { type: 'array', items: { type: 'number' } },
    ambiguous: { type: 'array', items: { type: 'number' } },
    unblocked: { type: 'array', items: { type: 'number' } },
  },
  required: ['closed'],
}
const RECONCILE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['completed', 'not-completed', 'ambiguous'] },
    result: { type: ['object', 'null'] },
    note: NULLABLE_STRING,
  },
  required: ['status'],
}

const PLAN_ROLE_SCHEMA = { type: 'object', properties: { planWritten: { type: 'boolean' } }, required: ['planWritten'] }
const REVIEW_PLAN_ROLE_SCHEMA = { type: 'object', properties: { reviewWritten: { type: 'boolean' }, reviewer: { type: 'string' } }, required: ['reviewWritten'] }
const IMPLEMENT_ROLE_SCHEMA = {
  type: 'object',
  properties: { implemented: { type: 'boolean' }, implementationNotesFile: NULLABLE_STRING, remaining: STRINGS },
  required: ['implemented'],
}
const REVIEW_TESTS_ROLE_SCHEMA = { type: 'object', properties: { flagged: { type: 'boolean' }, reviewer: { type: 'string' } }, required: ['flagged'] }
const AMEND_TESTS_ROLE_SCHEMA = { type: 'object', properties: { amended: { type: 'boolean' } }, required: ['amended'] }
const FIX_ROLE_SCHEMA = { type: 'object', properties: { fixed: { type: 'boolean' } }, required: ['fixed'] }
const FIX_CONFLICTS_ROLE_SCHEMA = {
  type: 'object',
  properties: { resolved: { type: 'boolean' }, unresolvedPaths: STRINGS },
  required: ['resolved'],
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// Every dispatch answers with one of these. An { ok: false } outcome already carries the
// exit note the run-failed chain must record, so no call site invents its own wording.
const dispatched = (value) => ({ ok: true, value })
const lost = (note) => ({ ok: false, note })

// Three distinct things can come back from one spawn, and rule 10 treats them differently:
// a value, a lost result (reconcile it), or an operational failure (run-failed at once).
const spawnAgent = async (prompt, options) => {
  try {
    const result = await agent(prompt, options)
    if (result === null || result === undefined) return { kind: 'lost' }
    return { kind: 'value', value: result }
  } catch (error) {
    const detail = error && error.message ? error.message : String(error)
    return { kind: 'error', note: detail }
  }
}

// No backtick fences here: a backtick in a prompt reads as shell command substitution.
const scriptPrompt = (scriptName, input) =>
  'Run this command with Bash, exactly as written:\n\n'
  + 'node "' + SCRIPTS_DIR + '/' + scriptName + '.ts" <<' + "'TASK_PAYLOAD'\n"
  + JSON.stringify(input) + '\nTASK_PAYLOAD\n\n'
  + 'Return exactly the JSON it prints, with no keys added or removed.\n'
  + 'If the command exits non-zero, do not invent a result. Fail, and report the exact stderr text.'

const rolePrompt = (role, input) =>
  'Run this command with Bash, exactly as written:\n\n'
  + 'node "' + EMITTER_PATH + '" ' + N + ' ' + role + ' <<' + "'TASK_PAYLOAD'\n"
  + JSON.stringify(input) + '\nTASK_PAYLOAD\n\n'
  + 'Follow the printed instructions.\n'
  + 'If the command exits non-zero, do not invent a result. Fail, and report the exact stderr text.'

const runReadOnlyScript = async (scriptName, payload, phaseTitle, schema) => {
  const input = { ...base(), ...payload }
  const prompt = scriptPrompt(scriptName, input)
  const options = { label: scriptName + ':' + N, phase: phaseTitle, schema }

  // Re-reading the world changes nothing, so a lost result is simply re-spawned.
  for (let attempt = 0; attempt < READ_ONLY_ATTEMPTS; attempt++) {
    const outcome = await spawnAgent(prompt, options)
    if (outcome.kind === 'value') return dispatched(outcome.value)
    if (outcome.kind === 'error') return lost(scriptName + ' failed operationally: ' + outcome.note)
  }
  return lost(scriptName + ' returned no result after ' + READ_ONLY_ATTEMPTS + ' attempts')
}

const reconcileLostStep = (scriptName, stepId, stepInput, phaseTitle) =>
  runReadOnlyScript('reconcileStep', { script: scriptName, stepId, stepInput }, phaseTitle, RECONCILE_SCHEMA)

// A mutating box is never blindly retried. Every lost result — including the one from the
// proved-safe rerun — is reconciled first, because both losses hide the same two worlds.
const runMutatingScript = async (scriptName, payload, phaseTitle, schema, stepId) => {
  const input = { ...base(), ...payload, stepId }
  const prompt = scriptPrompt(scriptName, input)
  const options = { label: scriptName + ':' + N, phase: phaseTitle, schema }

  const first = await spawnAgent(prompt, options)
  if (first.kind === 'value') return dispatched(first.value)
  if (first.kind === 'error') return lost(scriptName + ' failed operationally: ' + first.note)

  log('task ' + N + ': ' + scriptName + ' lost its result; reconciling ' + stepId)
  const firstVerdict = await reconcileLostStep(scriptName, stepId, input, phaseTitle)
  if (!firstVerdict.ok) return firstVerdict
  if (firstVerdict.value.status === 'completed') return dispatched(firstVerdict.value.result)
  if (firstVerdict.value.status === 'ambiguous') {
    return lost(scriptName + ' could not be reconciled: ' + firstVerdict.value.note)
  }

  // not-completed: the handler proved the mutation never landed, so one idempotent rerun is safe.
  const rerun = await spawnAgent(prompt, options)
  if (rerun.kind === 'value') return dispatched(rerun.value)
  if (rerun.kind === 'error') return lost(scriptName + ' failed operationally: ' + rerun.note)

  log('task ' + N + ': ' + scriptName + ' lost the rerun result too; reconciling ' + stepId + ' again')
  const secondVerdict = await reconcileLostStep(scriptName, stepId, input, phaseTitle)
  if (!secondVerdict.ok) return secondVerdict
  if (secondVerdict.value.status === 'completed') return dispatched(secondVerdict.value.result)
  if (secondVerdict.value.status === 'ambiguous') {
    return lost(scriptName + ' could not be reconciled after one proved-safe rerun: ' + secondVerdict.value.note)
  }
  // A second not-completed buys nothing: rerunning again would be a blind retry.
  return lost(scriptName + ' did not complete after one proved-safe rerun: ' + secondVerdict.value.note)
}

// A yellow box edits the worktree, so it is dispatched exactly once. Re-spawning it would
// reapply a plan, a conflict resolution or a test amendment on top of work that already landed.
const runRole = async (role, payload, phaseTitle, schema) => {
  const outcome = await spawnAgent(
    rolePrompt(role, { ...base(), ...payload }), { label: role + ':' + N, phase: phaseTitle, schema },
  )
  if (outcome.kind === 'value') return dispatched(outcome.value)
  if (outcome.kind === 'error') return lost('the ' + role + ' agent failed operationally: ' + outcome.note)
  return lost('the ' + role + ' agent produced no result')
}

// ---------------------------------------------------------------------------
// The common exit chain
// ---------------------------------------------------------------------------

const stopped = (exitType, exitNote, chainRan) => ({ task: N, exitType, exitNote, chainRan })

// Every exit except invalid-number, not-open and already-active runs this chain. A box that
// fails here logs and the chain runs on, because bailing would leave the source lock held.
const exitRun = async (exitType, exitNote, reopen = false) => {
  log('task ' + N + ': exiting ' + exitType)

  const notes = await runMutatingScript(
    'writeTaskExitNotes', { exitType, exitNote, reopen }, 'Close', EXIT_NOTES_SCHEMA, nextStepId('write-exit-notes'),
  )
  if (!notes.ok) log('task ' + N + ': ' + notes.note + '; the exit chain continues')

  const modified = await runMutatingScript(
    'recordTaskModifiedFiles', {}, 'Close', MODIFIED_FILES_SCHEMA, nextStepId('record-modified-files'),
  )
  if (!modified.ok) log('task ' + N + ': ' + modified.note + '; the exit chain continues')

  const inactive = await runMutatingScript('markTaskInactive', {}, 'Close', INACTIVE_SCHEMA, nextStepId('mark-inactive'))
  if (!inactive.ok) log('task ' + N + ': ' + inactive.note + '; the exit chain continues')
  runEnded = true

  const holds = await runMutatingScript(
    'releaseTaskRunHolds', { branchName }, 'Close', HOLDS_SCHEMA, nextStepId('release-holds'),
  )
  if (!holds.ok) log('task ' + N + ': ' + holds.note + '; a held source lock blocks every later task')

  return stopped(exitType, exitNote, true)
}

// Diagram rule 10: how far the exit chain runs depends on where the script failed.
const failRun = async (exitNote) => {
  if (!claimed) return stopped('run-failed', exitNote, false)
  return await exitRun('run-failed', exitNote, runEnded)
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const runPreflight = async () => {
  const numberValid = await runReadOnlyScript('isTaskNumberValid', {}, 'Preflight', NUMBER_VALID_SCHEMA)
  if (!numberValid.ok) return await failRun(numberValid.note)
  if (!numberValid.value.valid) {
    return stopped('invalid-number', 'task number is in neither tasks.json nor completedTasks.json', false)
  }

  const open = await runReadOnlyScript('isTaskOpen', {}, 'Preflight', TASK_OPEN_SCHEMA)
  if (!open.ok) return await failRun(open.note)
  if (!open.value.open) {
    // A task in both files is a close that stopped halfway; naming it is how a human finishes it.
    const closingNote = 'task is in both tasks.json and completedTasks.json: a previous close did not finish'
    return stopped('not-open', open.value.closeInProgress ? closingNote : 'task is already completed', false)
  }

  const claim = await runMutatingScript('claimTaskRun', {}, 'Preflight', CLAIM_SCHEMA, nextStepId('claim'))
  if (!claim.ok) return await failRun(claim.note)
  if (claim.value.status === 'refused') {
    return stopped('already-active', 'a previous run left the claim held', false)
  }
  if (claim.value.status === 'closing') {
    return stopped('already-active', 'the task is being archived by a close that has not finished', false)
  }
  if (claim.value.status === 'not-found') {
    // It was valid and open a moment ago, so something else deleted it.
    return await failRun('the task disappeared from tasks.json between the open check and the claim')
  }
  claimed = true

  const blocked = await runReadOnlyScript('isTaskBlocked', {}, 'Preflight', BLOCKED_SCHEMA)
  if (!blocked.ok) return await failRun(blocked.note)
  if (blocked.value.blocked) return await exitRun('blocked', 'an open blocker remains')

  return null
}

// ---------------------------------------------------------------------------
// Worktree
// ---------------------------------------------------------------------------

const adoptWorktree = (result) => {
  worktree = result.worktree
  branchName = result.branch
}

const buildFreshDocs = async () => {
  const docs = await runMutatingScript('generateTaskDocs', {}, 'Worktree', BRIEF_SCHEMA, nextStepId('generate-docs'))
  if (!docs.ok) return await failRun(docs.note)

  const amended = await runMutatingScript('amendExitNotesIntoBrief', {}, 'Worktree', AMEND_BRIEF_SCHEMA, nextStepId('amend-exit-notes'))
  if (!amended.ok) return await failRun(amended.note)

  return null
}

const refreshDocs = async () => {
  const docs = await runMutatingScript('updateTaskDocs', {}, 'Worktree', BRIEF_SCHEMA, nextStepId('update-docs'))
  if (!docs.ok) return await failRun(docs.note)
  return null
}

const runWorktree = async () => {
  const exists = await runReadOnlyScript('doesTaskWorktreeExist', {}, 'Worktree', WORKTREE_EXISTS_SCHEMA)
  if (!exists.ok) return await failRun(exists.note)

  if (!exists.value.exists) {
    const created = await runMutatingScript('createTaskWorktree', {}, 'Worktree', WORKTREE_SCHEMA, nextStepId('create-worktree'))
    if (!created.ok) return await failRun(created.note)
    adoptWorktree(created.value)
    return await buildFreshDocs()
  }

  worktree = exists.value.worktree
  branchName = 'task-' + N

  // Every existing-worktree path establishes ownership before any box writes to the worktree.
  // A failed clean-up deliberately retains the ended run's lease, so this is a normal state.
  const resumable = await runMutatingScript('isTaskRunResumable', {}, 'Worktree', RESUMABLE_SCHEMA, nextStepId('establish-lease'))
  if (!resumable.ok) return await failRun(resumable.note)
  if (!resumable.value.leaseEstablished) {
    return await failRun('the worktree lease is held by a live run that is not this one, so the existing worktree cannot be used')
  }

  const safe = await runReadOnlyScript('checkTaskWorktreeSafe', {}, 'Worktree', WORKTREE_SAFE_SCHEMA)
  if (!safe.ok) return await failRun(safe.note)
  if (safe.value.safe) return await refreshDocs()
  if (resumable.value.resumable) return await refreshDocs()

  const reset = await runMutatingScript('resetTaskWorktree', {}, 'Worktree', WORKTREE_SCHEMA, nextStepId('reset-worktree'))
  if (!reset.ok) return await failRun(reset.note)
  adoptWorktree(reset.value)
  return await buildFreshDocs()
}

const initSubmodules = async () => {
  const init = await runMutatingScript('initTaskSubmodules', {}, 'Worktree', SUBMODULES_SCHEMA, nextStepId('init-submodules'))
  if (!init.ok) return await failRun(init.note)
  return null
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

// A scrap is a scrap whether codex said so, the plan file failed validation, or the
// amendments were rejected. Count it, then check: the second scrap is the last one.
const scrapPlan = async (scrapNotes) => {
  planScraps += 1
  if (planScraps >= MAX_REPAIR_ATTEMPTS) {
    return { exit: await exitRun('plan-scrapped', 'codex scrapped the plan twice') }
  }
  return { preamble: scrapNotes || '' }
}

const runPlanning = async () => {
  let preamble = ''
  while (true) {
    const written = await runRole('plan', { preamble }, 'Plan', PLAN_ROLE_SCHEMA)
    if (!written.ok) return await failRun(written.note)

    const planValid = await runReadOnlyScript('validatePlanFile', { planFilePath: planFilePath() }, 'Plan', PLAN_VALID_SCHEMA)
    if (!planValid.ok) return await failRun(planValid.note)

    if (!planValid.value.valid) {
      const scrap = await scrapPlan(planValid.value.problem)
      if (scrap.exit) return scrap.exit
      preamble = scrap.preamble
      continue
    }

    const reviewed = await runRole('review-plan', {}, 'Plan', REVIEW_PLAN_ROLE_SCHEMA)
    if (!reviewed.ok) return await failRun(reviewed.note)

    const reviewValid = await runReadOnlyScript('validateCodexReview', { reviewFilePath: reviewFilePath() }, 'Plan', REVIEW_VALID_SCHEMA)
    if (!reviewValid.ok) return await failRun(reviewValid.note)

    if (!reviewValid.value.valid || reviewValid.value.verdict === 'scrap') {
      const scrap = await scrapPlan(reviewValid.value.scrapNotes || reviewValid.value.problem)
      if (scrap.exit) return scrap.exit
      preamble = scrap.preamble
      continue
    }

    const applied = await runMutatingScript(
      'applyPlanAmendments',
      { planFilePath: planFilePath(), reviewFilePath: reviewFilePath() },
      'Plan', AMENDMENTS_SCHEMA, nextStepId('apply-amendments'),
    )
    if (!applied.ok) return await failRun(applied.note)

    if (applied.value.status === 'rejected') {
      const scrap = await scrapPlan(applied.value.problem)
      if (scrap.exit) return scrap.exit
      preamble = scrap.preamble
      continue
    }

    return null
  }
}

// ---------------------------------------------------------------------------
// Implement
// ---------------------------------------------------------------------------

const runImplement = async () => {
  const worked = await runRole('implement', {}, 'Implement', IMPLEMENT_ROLE_SCHEMA)
  if (!worked.ok) return await failRun(worked.note)

  if (worked.value.implementationNotesFile) {
    const recorded = await runMutatingScript(
      'recordImplementationNotes',
      { implementationNotesFile: worked.value.implementationNotesFile },
      'Implement', NOTES_SCHEMA, nextStepId('record-notes'),
    )
    if (!recorded.ok) return await failRun(recorded.note)
  }

  return null
}

// ---------------------------------------------------------------------------
// Commit, shared by both test loops and the rebase tail
// ---------------------------------------------------------------------------

const commitIfNeeded = (phaseTitle) =>
  runMutatingScript('commitTaskWork', {}, phaseTitle, COMMIT_SCHEMA, nextStepId('commit'))

// ---------------------------------------------------------------------------
// Task tests
// ---------------------------------------------------------------------------

const runTaskTestLoop = async () => {
  while (true) {
    const committed = await commitIfNeeded('Test')
    if (!committed.ok) return await failRun(committed.note)

    const tests = await runMutatingScript('runTaskTests', {}, 'Test', TASK_TESTS_SCHEMA, nextStepId('task-tests'))
    if (!tests.ok) return await failRun(tests.note)

    if (!tests.value.passed) {
      if (testFixes >= MAX_REPAIR_ATTEMPTS) {
        return await exitRun('tests-red', 'task tests failed after 2 codebase fixes')
      }
      testFixes += 1
      const fix = await runRole('fix-tests', { checkoutPath: worktree, testOutput: tests.value.output }, 'Test', FIX_ROLE_SCHEMA)
      if (!fix.ok) return await failRun(fix.note)
      // An agent that reports it changed nothing reports the same thing next time.
      if (!fix.value.fixed) return await exitRun('tests-red', 'the fix-tests agent changed nothing')
      continue
    }

    const review = await runRole('review-tests', {}, 'Test', REVIEW_TESTS_ROLE_SCHEMA)
    if (!review.ok) return await failRun(review.note)
    if (!review.value.flagged) return null

    if (testAmendments >= MAX_REPAIR_ATTEMPTS) {
      return await exitRun('tests-flagged', 'codex flagged the tests twice')
    }
    testAmendments += 1
    const amended = await runRole(
      'amend-tests',
      { createdTestFiles: tests.value.createdTestFiles, testFiles: tests.value.testFiles },
      'Test', AMEND_TESTS_ROLE_SCHEMA,
    )
    if (!amended.ok) return await failRun(amended.note)
    if (!amended.value.amended) return await exitRun('tests-flagged', 'the amend-tests agent changed nothing')
  }
}

// ---------------------------------------------------------------------------
// Rebase, suite, fence, merge
// ---------------------------------------------------------------------------

// advanceTaskRebase always needs a layer to look at; the root checkout is the layer when nothing stopped.
const stoppedLayer = (stoppedAt) => stoppedAt || { occurrenceId: '', checkoutPath: worktree }

const runTail = async () => {
  let conflicted = false
  let stoppedAt = null
  let conflictedFilePaths = []
  let suiteFailureOutput = ''
  let mergeCommits = []

  const steps = {
    rebase: async () => {
      const rebase = await runMutatingScript('rebaseTaskWorktree', {}, 'Rebase', REBASE_SCHEMA, nextStepId('rebase'))
      if (!rebase.ok) return await failRun(rebase.note)

      // A warm lock is waited on; re-entering the box re-acquires the same owner token as a no-op.
      if (rebase.value.lock === 'held') {
        log('task ' + N + ': the source repository lock is held by ' + rebase.value.heldByOwner + '; re-entering the rebase box')
        return 'rebase'
      }
      if (rebase.value.lock === 'recoverable') {
        log('task ' + N + ': the source repository lock is stale, owned by ' + rebase.value.heldByOwner)
        log('task ' + N + ': a user must run this maintenance command: ' + rebase.value.recoveryCommand)
        return await exitRun('run-failed', 'the source repository lock is stale and owned by ' + rebase.value.heldByOwner
          + '; run this maintenance command, then start the task again: ' + rebase.value.recoveryCommand)
      }

      conflicted = rebase.value.conflicted
      stoppedAt = rebase.value.stoppedAt
      conflictedFilePaths = rebase.value.conflictedFilePaths || []
      return 'conflict-check'
    },

    'conflict-check': async () => {
      if (!conflicted) return 'commit-tail'
      if (conflictFixes >= MAX_REPAIR_ATTEMPTS) {
        return await exitRun('rebase-stuck', 'the rebase did not advance after 2 conflict fixes')
      }
      conflictFixes += 1

      const fix = await runRole(
        'fix-conflicts',
        { checkoutPath: stoppedLayer(stoppedAt).checkoutPath, conflictedFilePaths },
        'Rebase', FIX_CONFLICTS_ROLE_SCHEMA,
      )
      if (!fix.ok) return await failRun(fix.note)
      // resolved:false still advances; the advance box is what reports whether it worked.
      return 'commit-tail'
    },

    'commit-tail': async () => {
      const committed = await commitIfNeeded('Rebase')
      if (!committed.ok) return await failRun(committed.note)
      return 'advance'
    },

    advance: async () => {
      const advance = await runMutatingScript(
        'advanceTaskRebase', { stoppedAt: stoppedLayer(stoppedAt) }, 'Rebase', ADVANCE_SCHEMA, nextStepId('advance-rebase'),
      )
      if (!advance.ok) return await failRun(advance.note)

      if (advance.value.finished) return 'suite'

      if (advance.value.conflicted) {
        conflicted = true
        stoppedAt = advance.value.stoppedAt
        conflictedFilePaths = advance.value.conflictedFilePaths || []
        return 'conflict-check'
      }

      // The rebase helper stopped on red tests, which is a red full suite by another name.
      suiteFailureOutput = advance.value.failureReason || ''
      return 'suite-fix'
    },

    suite: async () => {
      const suite = await runMutatingScript('runFullSuite', {}, 'Suite', FULL_SUITE_SCHEMA, nextStepId('full-suite'))
      if (!suite.ok) return await failRun(suite.note)
      if (suite.value.passed) return 'fence'
      suiteFailureOutput = suite.value.output || ''
      return 'suite-fix'
    },

    'suite-fix': async () => {
      if (suiteFixes >= MAX_REPAIR_ATTEMPTS) {
        return await exitRun('suite-red', 'full suite still failing after 2 codebase fixes')
      }
      suiteFixes += 1

      const fix = await runRole(
        'fix-suite', { checkoutPath: worktree, testOutput: suiteFailureOutput }, 'Suite', FIX_ROLE_SCHEMA,
      )
      if (!fix.ok) return await failRun(fix.note)
      if (!fix.value.fixed) return await exitRun('suite-red', 'the fix-suite agent changed nothing')
      return 'commit-tail'
    },

    fence: async () => {
      const fence = await runReadOnlyScript('checkTaskFileFence', {}, 'Merge', FENCE_SCHEMA)
      if (!fence.ok) return await failRun(fence.note)
      if (fence.value.inside) return 'merge'
      log('task ' + N + ': fence violations: ' + (fence.value.violations || []).join(', '))
      return await exitRun('fence-violation', 'a step changed a file the task does not own')
    },

    merge: async () => {
      const merge = await runMutatingScript('mergeTaskWorktree', {}, 'Merge', MERGE_SCHEMA, nextStepId('merge'))
      if (!merge.ok) return await failRun(merge.note)

      if (!merge.value.merged) {
        mergeAttempts += 1
        if (mergeAttempts >= MAX_REPAIR_ATTEMPTS) {
          return await exitRun('merge-failed', 'the merge did not land twice')
        }
        log('task ' + N + ': the merge did not land; rebasing and retrying')
        return 'rebase'
      }

      mergeCommits = merge.value.commits || []
      return 'record-merge'
    },

    'record-merge': async () => {
      const recorded = await runMutatingScript(
        'recordMergeCommits', { commits: mergeCommits }, 'Close', MERGE_COMMITS_SCHEMA, nextStepId('record-merge-commits'),
      )
      if (!recorded.ok) return await failRun(recorded.note)
      return null
    },
  }

  let state = 'rebase'
  while (typeof state === 'string') state = await steps[state]()
  return state
}

// ---------------------------------------------------------------------------
// The success chain
// ---------------------------------------------------------------------------

const closeRun = async () => {
  const exitNote = 'archived to completedTasks.json'

  const notes = await runMutatingScript(
    'writeTaskExitNotes', { exitType: 'completed', exitNote, reopen: false }, 'Close', EXIT_NOTES_SCHEMA, nextStepId('write-exit-notes'),
  )
  if (!notes.ok) return await failRun(notes.note)

  const modified = await runMutatingScript('recordTaskModifiedFiles', {}, 'Close', MODIFIED_FILES_SCHEMA, nextStepId('record-modified-files'))
  if (!modified.ok) return await failRun(modified.note)

  const inactive = await runMutatingScript('markTaskInactive', {}, 'Close', INACTIVE_SCHEMA, nextStepId('mark-inactive'))
  if (!inactive.ok) return await failRun(inactive.note)
  runEnded = true

  // Clean-up owns releasing the source lock on the success path, which is why there is no release box here.
  const cleaned = await runMutatingScript('cleanupTaskWorktree', {}, 'Close', CLEANUP_SCHEMA, nextStepId('cleanup'))
  if (!cleaned.ok) return await failRun(cleaned.note)
  worktree = null

  const closure = await runReadOnlyScript('buildClosureNote', {}, 'Close', CLOSURE_NOTE_SCHEMA)
  if (!closure.ok) return await failRun(closure.note)

  const archived = await runMutatingScript(
    'closeTaskRun', { closureNote: closure.value.closureNote }, 'Close', CLOSE_SCHEMA, nextStepId('close'),
  )
  if (!archived.ok) return await failRun(archived.note)

  return stopped('completed', exitNote, true)
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

log('task ' + N + ': starting run ' + RUN_ID)

const preflightExit = await runPreflight()
if (preflightExit) return preflightExit

const worktreeExit = await runWorktree()
if (worktreeExit) return worktreeExit

const submodulesExit = await initSubmodules()
if (submodulesExit) return submodulesExit

const planExit = await runPlanning()
if (planExit) return planExit

const implementExit = await runImplement()
if (implementExit) return implementExit

const testExit = await runTaskTestLoop()
if (testExit) return testExit

const tailExit = await runTail()
if (tailExit) return tailExit

return await closeRun()
