export const meta = {
  name: 'tackle-task',
  description: 'Drive one active task from planning to merge, per plans/diagram/pipeline-*.mmd',
  phases: [
    { title: 'Plan', detail: 'write the plan, review it, replan or clarify' },
    { title: 'Implement', detail: 'implement, commit, run the task tests, review them' },
    { title: 'Rebase and merge', detail: 'lock the source repo, rebase, run the full suite, merge' },
    { title: 'Exit', detail: 'record the outcome, release what is held, report' },
  ],
}

/*
  meta comes first: the harness reads it as a pure literal.
*/

/*
  Drives paragraphs 18 to 97 of plans/tackle-tasks-v1_5-prompt.md.
*/

/*
  Paragraphs 1 to 17 already ran in PreambleDataEmitter.ts:runPreamble, at skill-invocation time.
*/

/*
  So this file starts from an active task, an initialized worktree, and a written brief.
*/

/*
  WIRED: the 6 [S] paragraphs 23, 30, 36, 45, 58, 63, as real agent() calls.
*/

/*
  NOT WIRED: the 90 [C] paragraphs. The sandbox cannot run a command, so each throws.
*/

/*
  FAKE MODE: args.fake supplies every [C] decision, so a path walks offline with no repository.
*/

/*
  Paragraph 18: resumption is worktree-level, so there is no resume entry point here.
*/

/*
  Paragraph 19: the preamble initializes submodules on every path, before this file runs.
*/

const TASK = args.task
const EMITTER = args.agentPromptEmitterPath
const WORKTREE = args.worktree
const PROJECT_ROOT = args.projectRoot
const SOURCE_BRANCH = args.sourceBranch
const RUN_ID = args.runId
const FAKE = args && typeof args === 'object' ? args.fake : null
const isFake = () => FAKE !== null && FAKE !== undefined

// ---------------------------------------------------------------------------
// Diagram labels, spliced from plans/diagram/*.mmd by generateTaskWorkflow.ts
// ---------------------------------------------------------------------------

/*
  Every label below is its node's text. A typo fails the build, never a run.
*/

// GENERATED LABELS

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

const trace = []
const INDENT = '  '
let depth = 0

/*
  One diagram box, indented one level per repeat of a loop.
*/
const step = (label, suffix) => {
  const line = INDENT.repeat(depth) + (suffix === undefined ? label : `${label}: ${suffix}`)
  trace.push(line)
  log(line)
  return line
}

/*
  A sub-pipeline boundary, one per plans/diagram/pipeline-<name>.mmd file. Never indented.
*/
const banner = (name) => {
  const line = `--------- ${name} ---------`
  trace.push(line)
  log(line)
  return line
}

const yesNo = (value) => (value ? 'YES' : 'NO')

/*
  Reads one attempt's outcome; past the end of the list the last entry repeats.
*/
const attempt = (outcomes, index) => outcomes[Math.min(index, outcomes.length - 1)]

/*
  A [C] box. Throws naming its diagram box, because the sandbox cannot run its script.
*/
const notWired = (box) => {
  throw new Error(`tackle-tasks workflow: [C] box not wired yet — ${box}`)
}

/*
  A [C] decision. Real mode throws; fake mode reads the fixture, so a path walks offline.
*/
const decide = (box, field, index) => {
  if (!isFake()) return notWired(box)
  return attempt(FAKE[field], index)
}

/*
  Paragraph 3: an operational script failure ends the run as run-failed, from any green box.
*/

/*
  Paragraph 4: a lost mutating result is reconciled first, never blindly retried.
*/

/*
  The whole prompt for an [S] box, per workflow-only-context-injection.md section 3.
*/
const emitterPrompt = (role, extra) => {
  // Serialized, never interpolated, and delivered on quoted-heredoc stdin.
  const payload = JSON.stringify(Object.assign(
    { worktree: WORKTREE, projectRoot: PROJECT_ROOT, sourceBranch: SOURCE_BRANCH, runId: RUN_ID },
    extra || {},
  ))
  // No backtick anywhere: a prompt is not a shell, and command substitution never expands here.
  return `Run this with Bash:
node ${EMITTER} ${TASK} ${role} <<'TTPAYLOAD'
${payload}
TTPAYLOAD
Follow the printed instructions.`
}

const agentVisits = new Map()

/*
  An [S] box. A null result is the diagram's dotted "agent() errored" edge.
*/
const runAgent = async (label, box, role, schema, extra) => {
  step(`<-- AGENT --> ${label}`)
  const visit = agentVisits.get(box) ?? 0
  agentVisits.set(box, visit + 1)
  if (isFake()) {
    const errored = attempt((FAKE.agentErrors ?? {})[box] ?? [false], visit)
    if (errored) step(L.AGENT_ERRORED)
    return errored ? null : {}
  }
  const result = await agent(emitterPrompt(role, extra), { label: `${role}:${TASK}`, schema })
  if (result === null) step(L.AGENT_ERRORED)
  return result
}

// ---------------------------------------------------------------------------
// Return shapes for the 6 agent boxes
// ---------------------------------------------------------------------------

const PLAN_RESULT = {
  type: 'object',
  required: ['outcome'],
  properties: {
    outcome: { type: 'string', enum: ['PLAN', 'CLARIFY', 'ERROR'] },
    clarifyRequest: { type: 'string' },
  },
}

const REVIEW_PLAN_RESULT = {
  type: 'object',
  required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['ACCEPT', 'AMEND_THEN_ACCEPT', 'AMEND', 'SCRAP', 'ERROR'] },
    notes: { type: 'string' },
  },
}

const IMPLEMENT_RESULT = {
  type: 'object',
  required: ['implemented'],
  properties: { implemented: { type: 'boolean' }, notes: { type: 'string' } },
}

const REVIEW_TESTS_RESULT = {
  type: 'object',
  required: ['flagged'],
  properties: { flagged: { type: 'boolean' }, notes: { type: 'string' } },
}

const FIX_CONFLICTS_RESULT = {
  type: 'object',
  required: ['resolved'],
  properties: {
    resolved: { type: 'boolean' },
    unresolvedPaths: { type: 'array', items: { type: 'string' } },
  },
}

const FIX_SUITE_RESULT = {
  type: 'object',
  required: ['fixed'],
  properties: { fixed: { type: 'boolean' }, notes: { type: 'string' } },
}

// ---------------------------------------------------------------------------
// Plan-file validators, spliced from planArtifacts.ts by generateTaskWorkflow.ts
// ---------------------------------------------------------------------------

/*
  The v1.5 diagrams dropped the receipt-validity boxes, so nothing calls these yet.
*/

// GENERATED VALIDATORS

// ---------------------------------------------------------------------------
// Counters — paragraph 5
// ---------------------------------------------------------------------------

/*
  Every counter counts fix attempts, not failing runs, so two allows three runs.
*/

/*
  None is written to tasks.json, so each invocation starts at zero.
*/

/*
  conflictFixes and suiteFixes live here and never reset: a merge-triggered rebase respends them.
*/

const MAX_ATTEMPTS = 2

let clarifyRounds = 0
let planReviews = 0
let testFixes = 0
let testReviews = 0
let conflictFixes = 0
let suiteFixes = 0
let mergeAttempts = 0

let plannerIndex = 0
let verdictIndex = 0
let testsIndex = 0
let flaggedIndex = 0
let lockIndex = 0
let conflictsIndex = 0
let finishedIndex = 0
let suiteIndex = 0
let publicationIndex = 0

const AGENT_FAILED_NOTE = 'the agent returned nothing usable'

// ---------------------------------------------------------------------------
// Exits
// ---------------------------------------------------------------------------

/*
  Every exit below the preamble takes the failures tail, because the task is already active.
*/
const toFailures = (exitType, exitNote, workLanded) => ({ done: true, exitType, exitNote, workLanded: workLanded === true })

/*
  Taken from the rebase preamble onward, and released by whichever exit tail runs.
*/
let sourceLockHeld = false

/*
  plans/diagram/pipeline-failuresExit.mmd. Every box is [C].
*/
const failuresExit = (exitType, exitNote, workLanded) => {
  banner('failures exit')
  // Paragraph 85: ask git what landed before writing anything, never the incoming exit type.
  step(L.READ_PUBLICATION_STATE)
  step(L.DID_ANY_WORK_LAND, yesNo(workLanded))
  // Paragraph 86: landed work discards the incoming exit type, run-failed included.
  if (workLanded) step(L.WRITE_PUBLICATION_OUTCOME)
  else step(L.WRITE_EXIT_TYPE_AND_NOTE, exitType.toUpperCase())
  step(L.RECORD_MODIFIED_FILES_FAILURE)
  // Paragraphs 89 and 90: the lease and the source lock are independent ownership checks.
  step(L.DOES_RUN_HOLD_LEASE, 'YES')
  // Paragraph 93: the worktree is never removed here, only its lease released.
  step(L.RELEASE_WORKTREE_LEASE)
  step(L.DOES_RUN_HOLD_SOURCE_LOCK, yesNo(sourceLockHeld))
  if (sourceLockHeld) step(L.RELEASE_SOURCE_LOCK)
  // Paragraph 91: mark inactive last, after every release and every write.
  step(L.MARK_TASK_INACTIVE_FAILURE)
  step(L.REPORT_EXIT_TYPE_AND_NOTE, exitType.toUpperCase())
  step(L.STOP)
  return { task: TASK, exitType, exitNote, trace }
}

/*
  Paragraph 94: every mutating box on that tail is reconciled, not retried.
*/

/*
  plans/diagram/pipeline-mergeSucceededExit.mmd. Every box is [C].
*/
const mergeSucceededExit = () => {
  banner('merge succeeded exit')
  step(L.MERGE_RECEIPT_INPUT)
  step(L.RECORD_MERGE_COMMIT_HASHES)
  // Paragraph 79: completed is the point of no return, written before any release.
  step(L.WRITE_EXIT_TYPE_COMPLETED)
  step(L.RECORD_MODIFIED_FILES_SUCCESS)
  // Paragraph 81: the only box releasing both the source lock and the worktree lease.
  step(L.CLEAN_UP_WORKTREES)
  step(L.BUILD_CLOSURE_NOTE)
  step(L.MARK_TASK_INACTIVE_SUCCESS)
  step(L.ARCHIVE_TASK)
  step(L.REPORT_CLOSURE_NOTE)
  step(L.STOP)
  return { task: TASK, exitType: 'completed', exitNote: '', trace }
}

/*
  Paragraph 84: the merge's layer refs make a dead run safe, not this tail.
*/

// ---------------------------------------------------------------------------
// Plan — plans/diagram/pipeline-plan.mmd, paragraphs 23 to 29
// ---------------------------------------------------------------------------

const planPipeline = async () => {
  banner('plan')
  phase('Plan')
  step(L.DOCS_INPUT)

  // Paragraph 23 [S]: turn the tasks.json entry into a plan, reading the entry and docs only.
  const result = await runAgent(L.PLAN_THE_TASK, 'PLANNER', 'plan', PLAN_RESULT)

  // Paragraph 26: nothing usable back, and the task is active, so the failures exit runs.
  if (result === null) return toFailures('agent-failed', AGENT_FAILED_NOTE)

  const outcome = isFake() ? attempt(FAKE.plannerOutcome, plannerIndex) : result.outcome
  plannerIndex += 1
  step(L.WHAT_DID_THE_PLANNER_RETURN, outcome)

  if (outcome === 'ERROR') return toFailures('agent-failed', AGENT_FAILED_NOTE)
  // Paragraph 25.
  if (outcome === 'PLAN') return { next: 'review-plan' }

  // Paragraph 27: CLARIFY is how a planner asks for what it was never given.
  const roundsDone = clarifyRounds >= MAX_ATTEMPTS
  // Capped at 2 rounds: no user answers, so a third ask learns nothing new.
  step(L.ARE_2_CLARIFY_ROUNDS_DONE, yesNo(roundsDone))

  // Paragraph 29.
  if (roundsDone) {
    return toFailures(
      'clarify-stuck',
      'the planner asked twice for something the docs cannot supply. worktree preserved.',
    )
  }

  clarifyRounds += 1
  // Paragraph 28: the planner reads only the entry and the docs, so write it there.
  step(L.WRITE_CLARIFY_REQUEST)
  depth += 1
  return { next: 'document-generation' }
}

// ---------------------------------------------------------------------------
// Document generation — plans/diagram/pipeline-documentGeneration.mmd, paragraphs 20 to 22
// ---------------------------------------------------------------------------

const documentGenerationPipeline = async () => {
  banner('document generation')
  step(L.WORKTREE_DOCS_MODE_INPUT)
  // A clarify round always re-enters in UPDATE mode; AUTOGEN belongs to the preamble.
  step(L.WHAT_IS_DOCS_MODE, 'UPDATE')
  // Paragraph 21: UPDATE docs read the clarify request and grow to cover what it names.
  step(L.UPDATE_AUTO_GENERATED_DOCS)
  return { next: 'plan' }
}

// ---------------------------------------------------------------------------
// Review plan — plans/diagram/pipeline-reviewPlan.mmd, paragraphs 30 to 35
// ---------------------------------------------------------------------------

const reviewPlanPipeline = async () => {
  banner('review plan')
  step(L.DRAFT_PLAN_INPUT)

  // Paragraph 30 [S].
  const result = await runAgent(L.CODEX_REVIEWS_PLAN, 'PLAN_REVIEWER', 'review-plan', REVIEW_PLAN_RESULT)

  // Paragraph 31.
  if (result === null) return toFailures('agent-failed', AGENT_FAILED_NOTE)

  const verdict = isFake() ? attempt(FAKE.planVerdict, verdictIndex) : result.verdict
  verdictIndex += 1
  step(L.WHAT_IS_REVIEW_VERDICT, verdict)

  // The reviewer never read the plan, so this is an operational failure, not a plan defect.
  if (verdict === 'ERROR') return toFailures('run-failed', result.notes ?? 'the plan review could not run')

  // Paragraph 32. AMEND_THEN_ACCEPT skips a second review: the fixes are already in the plan.
  if (verdict === 'ACCEPT' || verdict === 'AMEND_THEN_ACCEPT') return { next: 'implement' }

  // Paragraph 33: the planner reads the entry, so codex's notes go into it before replanning.
  step(L.UPDATE_TASK_ENTRY)
  planReviews += 1

  const reviewsDone = planReviews >= MAX_ATTEMPTS
  step(L.ARE_2_REVIEWS_DONE, yesNo(reviewsDone))

  // Paragraph 35: the task cannot be planned as written and needs dividing.
  if (reviewsDone) return toFailures('plan-scrapped', 'codex did not accept the plan in two reviews')

  // Paragraph 34.
  depth += 1
  return { next: 'plan' }
}

// ---------------------------------------------------------------------------
// Implement — plans/diagram/pipeline-implement.mmd, paragraphs 36 to 40
// ---------------------------------------------------------------------------

const implementPipeline = async () => {
  banner('implement')
  phase('Implement')
  step(L.ACCEPTED_PLAN_INPUT)

  // Paragraph 36 [S]: implement the accepted plan, treating the worktree as project root.
  const result = await runAgent(L.IMPLEMENT_TASK, 'IMPLEMENTER', 'implement', IMPLEMENT_RESULT)

  // Paragraph 37.
  if (result === null) return toFailures('agent-failed', AGENT_FAILED_NOTE)

  // Paragraph 38: commit dirty work, commit nothing clean; later steps rebase and would lose it.
  step(L.COMMIT_IF_NEEDED)
  return { next: 'task-tests' }
}

/*
  Paragraph 39: the source lock is not taken here; the rebase preamble takes it later.
*/

/*
  Paragraph 40: both test pipelines re-enter implement, each amending the entry first.
*/

// ---------------------------------------------------------------------------
// Task tests — plans/diagram/pipeline-taskTests.mmd, paragraphs 41 to 44
// ---------------------------------------------------------------------------

const taskTestsPipeline = async () => {
  banner('task tests')
  step(L.COMMITTED_WORK_INPUT)

  // Paragraph 41: run only this task's tests; the full suite belongs to the rebase phase.
  step(L.RUN_TASK_TESTS)
  const testsPass = decide('RUN_TASK_TESTS', 'taskTestsPass', testsIndex)
  testsIndex += 1
  step(L.DO_TASK_TESTS_PASS, yesNo(testsPass))
  if (testsPass) return { next: 'review-tests' }

  // Paragraph 42: ask the counter BEFORE amending, or the first failure spends it.
  const fixesDone = testFixes >= MAX_ATTEMPTS
  step(L.ARE_2_TEST_FIXES_DONE, yesNo(fixesDone))

  // Paragraph 44.
  if (fixesDone) return toFailures('tests-red', 'task tests still failing after 2 fix attempts')

  // Paragraph 43: a repair is never tested until committed, so re-enter implement.
  step(L.AMEND_ENTRY_WITH_FAILING_TESTS)
  testFixes += 1
  depth += 1
  return { next: 'implement' }
}

// ---------------------------------------------------------------------------
// Review task tests — plans/diagram/pipeline-reviewTests.mmd, paragraphs 45 to 50
// ---------------------------------------------------------------------------

const reviewTestsPipeline = async () => {
  banner('review task tests')
  step(L.GREEN_IMPLEMENTATION_INPUT)

  // Paragraph 45 [S]: review the tests, not the codebase.
  const result = await runAgent(L.CODEX_REVIEWS_TESTS, 'TEST_REVIEWER', 'review-tests', REVIEW_TESTS_RESULT)

  // Paragraph 47.
  if (result === null) return toFailures('agent-failed', AGENT_FAILED_NOTE)

  const flagged = isFake() ? attempt(FAKE.testsFlagged, flaggedIndex) : result.flagged
  flaggedIndex += 1
  step(L.ARE_TESTS_FLAGGED, yesNo(flagged))

  // Paragraph 48.
  if (!flagged) return { next: 'rebase-preamble' }

  const reviewsDone = testReviews >= MAX_ATTEMPTS
  step(L.ARE_2_TEST_REVIEWS_DONE, yesNo(reviewsDone))

  // Paragraph 50.
  if (reviewsDone) return toFailures('tests-flagged', 'task tests failed codex review')

  // Paragraph 49: write codex's notes and fixes into the entry, then reimplement.
  step(L.AMEND_ENTRY_WITH_CODEX_NOTES)
  testReviews += 1
  depth += 1
  return { next: 'implement' }
}

/*
  Paragraph 46: reviewTestsPrompt passes three of the seven inputs the diagram names.
*/

/*
  The diff and pre-existing tests are derived here, from the merge-base with the target.
*/

// ---------------------------------------------------------------------------
// Rebase preamble — plans/diagram/pipeline-rebasePreamble.mmd, paragraphs 51 to 55
// ---------------------------------------------------------------------------

const rebasePreamblePipeline = async () => {
  banner('rebase preamble')
  phase('Rebase and merge')
  step(L.FINISHED_IMPLEMENTATION_INPUT)

  // Paragraph 51: the lock owner is runId:taskNumber, never runId alone.
  step(L.LOCK_SOURCE_REPO)
  const acquired = decide('LOCK_SOURCE_REPO', 'lockAcquired', lockIndex)
  lockIndex += 1
  step(L.WAS_LOCK_ACQUIRED, yesNo(acquired))

  // Paragraphs 52 and 53: the 5s poll and its 15-minute cap live inside the script.
  if (!acquired) {
    step(L.HAVE_15_MINUTES_PASSED, 'YES')
    return toFailures('run-failed', 'the source repo lock did not come free within 15 minutes')
  }

  sourceLockHeld = true
  return { next: 'rebase' }
}

/*
  Paragraph 54: the lock file sits under <projectRoot>/.git and is cleared by hand.
*/

/*
  Paragraph 55: every rebase, suite and merge box refreshes the lock heartbeat on entry.
*/

// ---------------------------------------------------------------------------
// Rebase — plans/diagram/pipeline-rebase.mmd, paragraphs 56 to 61
// ---------------------------------------------------------------------------

const rebasePipeline = async () => {
  banner('rebase')
  step(L.SOURCE_REPO_LOCKED_INPUT)

  for (;;) {
    // Paragraphs 56 and 57: deepest layer first, skipping every layer the receipt calls landed.
    step(L.REBASE_ONTO_TARGET_BRANCH)
    const conflicted = decide('REBASE_ONTO_TARGET_BRANCH', 'rebaseConflicts', conflictsIndex)
    conflictsIndex += 1
    step(L.DID_REBASE_REPORT_CONFLICTS, yesNo(conflicted))
    if (!conflicted) return { next: 'suite' }

    const fixesDone = conflictFixes >= MAX_ATTEMPTS
    step(L.ARE_2_CONFLICT_FIXES_DONE, yesNo(fixesDone))

    // Paragraph 61.
    if (fixesDone) {
      return toFailures('rebase-stuck', 'the rebase did not advance after 2 conflict fixes')
    }

    // Paragraph 58 [S]: leave the markers, pass the stopped layer and its files.
    const result = await runAgent(L.FIX_CONFLICTS, 'CONFLICT_FIXER', 'fix-conflicts', FIX_CONFLICTS_RESULT, {
      checkoutPath: WORKTREE,
      conflictedFilePaths: [],
    })

    // Paragraph 59.
    if (result === null) return toFailures('agent-failed', AGENT_FAILED_NOTE)

    conflictFixes += 1

    // Paragraph 60: always fix, then commit, then continue — never fix then continue.
    step(L.COMMIT_IF_NEEDED)
    step(L.CONTINUE_REBASE)
    const finished = decide('CONTINUE_REBASE', 'rebaseFinished', finishedIndex)
    finishedIndex += 1
    step(L.IS_REBASE_FINISHED, yesNo(finished))
    if (finished) return { next: 'suite' }
    // A rebase can stop more than once, so an unfinished rebase turns this loop again.
    depth += 1
  }
}

// ---------------------------------------------------------------------------
// Full suite — plans/diagram/pipeline-suite.mmd, paragraphs 62 to 69
// ---------------------------------------------------------------------------

const suitePipeline = async () => {
  banner('full suite')
  step(L.REBASED_WORKTREE_INPUT)

  for (;;) {
    // Paragraph 62: the full suite is what proves the task broke nothing else.
    step(L.RUN_FULL_SUITE)
    const passes = decide('RUN_FULL_SUITE', 'suitePasses', suiteIndex)
    suiteIndex += 1
    step(L.DO_ALL_TESTS_PASS, yesNo(passes))
    if (passes) break

    const fixesDone = suiteFixes >= MAX_ATTEMPTS
    step(L.ARE_2_SUITE_FIXES_DONE, yesNo(fixesDone))

    // Paragraph 66.
    if (fixesDone) {
      return toFailures(
        'suite-red',
        'full suite still red after 2 fix attempts. merge aborted. worktree preserved.',
      )
    }

    // Paragraph 63 [S]: pass the failing tests, and fix the codebase, not the tests.
    const result = await runAgent(
      L.FIX_THE_CODEBASE_FOR_SUITE,
      'SUITE_FIXER',
      'fix-suite',
      FIX_SUITE_RESULT,
      { checkoutPath: WORKTREE, testOutput: '', forbiddenPaths: [] },
    )

    // Paragraph 65.
    if (result === null) return toFailures('agent-failed', AGENT_FAILED_NOTE)

    suiteFixes += 1

    // Paragraph 64: commit the repair before rerunning, so it is fix, commit, run.
    step(L.COMMIT_IF_NEEDED)
    depth += 1
  }

  // Paragraph 67: the fence gate runs once, after the fix loop and before the merge.
  const fenceHeld = isFake() ? FAKE.fenceHeld : notWired('DID_CHANGES_STAY_INSIDE_FENCE')
  // Paragraph 68: it re-derives the diff and never accepts a fence from a caller.
  step(L.DID_CHANGES_STAY_INSIDE_FENCE, yesNo(fenceHeld))
  if (!fenceHeld) {
    return toFailures(
      'fence-violation',
      'a repair edited files the task does not own. nothing merged. worktree preserved.',
    )
  }
  return { next: 'merge' }
}

/*
  Paragraph 69 is a known ceiling: one suite run can outlast the 15-minute lock.
*/

// ---------------------------------------------------------------------------
// Merge — plans/diagram/pipeline-merge.mmd, paragraphs 70 to 78
// ---------------------------------------------------------------------------

const mergePipeline = async () => {
  banner('merge')
  step(L.GREEN_WORKTREE_INPUT)

  // Paragraphs 70 and 71: no fast-forward, and each layer writes its merge ref as it lands.
  step(L.MERGE_WORKTREES)

  // Paragraph 72: a read-only reconciliation over those refs, never a returned boolean.
  step(L.READ_PUBLICATION_STATE)
  const state = decide('WHAT_IS_PUBLICATION_STATE', 'publicationState', publicationIndex)
  publicationIndex += 1
  // Paragraph 73: merged, no-op and root-merged-but-not-closed are LANDED; conflicted is not.
  step(L.WHAT_IS_PUBLICATION_STATE, state)

  // Paragraph 74.
  if (state === 'ALL LANDED') return { next: 'merge-succeeded' }

  // Paragraph 77: never retry a partial publication; it would re-land around public work.
  if (state === 'SOME LANDED') {
    return toFailures(
      'partially-published',
      'some layers are on their target branch and some are not. RECOVERY ONLY. worktree preserved.',
      true,
    )
  }

  const attemptsDone = mergeAttempts >= MAX_ATTEMPTS
  step(L.ARE_2_MERGE_ATTEMPTS_DONE, yesNo(attemptsDone))

  // Paragraph 76.
  if (attemptsDone) return toFailures('merge-failed', 'nothing landed after 2 attempts. worktree preserved.')

  mergeAttempts += 1
  depth += 1
  // Paragraph 75: re-enter rebase, not the rebase preamble; the target branch tip moved.
  return { next: 'rebase' }
}

/*
  Paragraph 78: a no-op layer is a real completion, so an all-no-op task lands ALL LANDED.
*/

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/*
  The diagrams have back-edges, so the pipelines are a state machine, not a chain.
*/
const PIPELINES = {
  'plan': planPipeline,
  'document-generation': documentGenerationPipeline,
  'review-plan': reviewPlanPipeline,
  'implement': implementPipeline,
  'task-tests': taskTestsPipeline,
  'review-tests': reviewTestsPipeline,
  'rebase-preamble': rebasePreamblePipeline,
  'rebase': rebasePipeline,
  'suite': suitePipeline,
  'merge': mergePipeline,
}

const driver = async () => {
  trace.push(`Run start: Task Num [${TASK}]`)
  log(trace[0])

  let current = 'plan'
  for (;;) {
    const result = await PIPELINES[current]()

    if (result.done) {
      phase('Exit')
      failuresExit(result.exitType, result.exitNote, result.workLanded)
      return trace
    }
    if (result.next === 'merge-succeeded') {
      phase('Exit')
      mergeSucceededExit()
      return trace
    }
    current = result.next
  }
}

return driver()
