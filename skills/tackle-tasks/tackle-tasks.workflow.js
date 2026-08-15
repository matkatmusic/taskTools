export const meta = {
  name: 'tackle-task',
  description: 'Drive one task from validation to merge, per plans/diagram/pipeline.mmd',
  phases: [
    { title: 'Preamble', detail: 'validate the number, mark the task active, prepare the worktree' },
    { title: 'Planning', detail: 'write the plan, review it, apply amendments' },
    { title: 'Implement and test', detail: 'implement, run the task tests, review them, lock the source repo' },
    { title: 'Rebase and merge', detail: 'rebase, run the full suite, check the fence, merge' },
    { title: 'Exit workflow', detail: 'record the outcome, release what is held, report' },
  ],
}

// meta must be the very first thing in the file — the Workflow harness reads it as a pure
// literal before evaluating anything else, so nothing may precede it, comments included.
//
// Drives one task from validation to merge. The shape of this file is dictated by
// plans/diagram/*.mmd — every step() line below is a node label copied verbatim from a diagram.
//
// The sandbox cannot import, require, read files, or run commands. Everything is inline, and
// every box that does work — script boxes and agent boxes alike — goes through run(). A
// subagent's Bash is the only way to run a command here, so a "script" box (git, tasks.json,
// tests) is executed the same way an "agent" box (plan, review, fix) is: there is one chokepoint,
// not two.
//
// FAKE MODE: pass args.fake = <a fixture from scripts/tracePipelinePaths.json> and run()
// returns the canned receipt from its call site instead of launching anything. That lets the
// whole pipeline walk any path in the diagrams offline, so its output can be diffed against
// scripts/tracePipeline.ts. tests/workflowMatchesTracer.test.ts is the guard against the
// labels below drifting from the diagrams.
//
// REAL MODE: deliberately not built. Every decision that would need a real reconciliation
// script, a real structure validator, or a real git/test result routes through realDecisions(),
// which throws naming the missing piece instead of silently taking the happy path.

// ---------------------------------------------------------------------------
// Skeleton. Phase functions below use ONLY these helpers and invent nothing.
// ---------------------------------------------------------------------------

const FAKE = args && typeof args === 'object' ? args.fake : null
const isFake = () => FAKE !== null && FAKE !== undefined

const trace = []
let depth = 0

/** One diagram box. `label` must be copied verbatim from the .mmd node. */
const step = (label, suffix) => {
  const line = '  '.repeat(depth) + (suffix === undefined ? label : `${label}: ${suffix}`)
  trace.push(line)
  log(line)
  return line
}

/** A sub-pipeline boundary. Never indented — it is a divider, not a step inside a loop. */
const banner = (name) => {
  const line = `--------- ${name} ---------`
  trace.push(line)
  log(line)
  return line
}

/** A repeat of a two-strike loop is indented one level, matching the tracer. */
const enterRetry = () => { depth += 1 }
const leaveRetry = () => { depth -= 1 }

const yesNo = (value) => (value ? 'YES' : 'NO')

/** The diagram's orange-box marker, prefixed onto an agent box's label. */
const AGENT_MARK = '<-- AGENT -->'

/** Every box that does work. In fake mode `canned()` stands in for the real run; in real mode
 *  the sandbox hands the prompt to the injected `agent()` — the only way anything here can run
 *  a command. `isAgentBox` matches the diagram's orange boxes with the tracer's AGENT marker. */
const run = async (label, prompt, opts, canned, isAgentBox = false) => {
  step(isAgentBox ? `${AGENT_MARK} ${label}` : label)
  if (isFake()) return canned()
  return agent(prompt, opts)
}

/** Real mode is deliberately not built. Every decision that would need a real reconciliation
 *  script, structure validator, or git/test result calls this instead of guessing a default. */
const realDecisions = (what) => {
  throw new Error(`tackle-tasks workflow: real mode not implemented yet for ${what}`)
}

/** Output -> Receipt -> structure check -> Output -> the same receipt, now trusted. */
const receipt = (outputLabel, receiptLabel, validQuestion, valid) => {
  step(outputLabel)
  step(receiptLabel)
  step(validQuestion, yesNo(valid))
  if (!valid) return false
  step(outputLabel)
  step(receiptLabel)
  return true
}

/** The failure tail. Never validated — that would feed the exit workflow into itself. */
const exitChain = (exitType, exitNote, held) => {
  const shoutedExitType = exitType.toUpperCase()
  banner('exit workflow')
  if (held.noRunRecord) {
    step('report the exit type and note', shoutedExitType)
    step('stop')
    return trace
  }
  step('write exit type and exit notes to tasks.json', shoutedExitType)
  step('record modified files to tasks.json')
  step('mark task inactive in tasks.json')
  step('was a worktree created?', yesNo(held.lease))
  if (!held.lease) {
    step('nothing to release')
  } else {
    step('was the source repo locked?', yesNo(held.sourceLock))
    step(held.sourceLock ? 'release the worktree lease and the source lock' : 'release the worktree lease')
  }
  step("report the run's exit type and note", shoutedExitType)
  step('stop')
  return trace
}

// ---------------------------------------------------------------------------
// Preamble (plans/diagram/pipeline-preamble.mmd)
// ---------------------------------------------------------------------------

const preamblePhase = async () => {
  const d = isFake() ? FAKE : realDecisions('preamble decisions')

  step('is task number valid?', yesNo(d.taskNumberValid))
  if (!d.taskNumberValid) {
    return {
      ok: false,
      trace: exitChain(
        'invalid-number',
        'task number is in neither tasks.json nor completedTasks.json',
        { lease: false, sourceLock: false, noRunRecord: true },
      ),
    }
  }

  step('is task open?', yesNo(d.taskOpen))
  if (!d.taskOpen) {
    return {
      ok: false,
      trace: exitChain(
        'not-open',
        'task is already completed',
        { lease: false, sourceLock: false, noRunRecord: true },
      ),
    }
  }

  // Drawn as two boxes, but one atomic read-modify-write of tasks.json: nothing
  // can make the task active between the question and the write.
  step('is the task active?', yesNo(d.taskActive))
  if (d.taskActive) {
    return {
      ok: false,
      trace: exitChain(
        'already-active',
        'a previous run left the task active',
        { lease: false, sourceLock: false, noRunRecord: true },
      ),
    }
  }
  await run(
    'Try: mark the task active in tasks.json',
    'Mark this task active in tasks.json.',
    {},
    () => ({}),
  )

  step('is task blocked?', yesNo(d.taskBlocked))
  if (d.taskBlocked) {
    return {
      ok: false,
      trace: exitChain(
        'blocked',
        'an open blocker remains',
        { lease: false, sourceLock: false, noRunRecord: false },
      ),
    }
  }

  // Four worktree shapes converge on "init submodules recursively".
  step('does a worktree exist?', yesNo(d.worktreeExists))
  if (!d.worktreeExists) {
    await run('create a worktree', 'Create a git worktree for this task.', {}, () => ({}))
    await run('auto generate docs', 'Auto-generate this worktree docs.', {}, () => ({}))
  } else {
    step('is the worktree safe to use?', yesNo(d.worktreeSafe))
    if (d.worktreeSafe) {
      await run('update auto generated docs', 'Update the auto-generated docs.', {}, () => ({}))
    } else {
      step("is the previous run's work resumable?", yesNo(d.previousWorkResumable))
      if (d.previousWorkResumable) {
        await run('update auto generated docs', 'Update the auto-generated docs.', {}, () => ({}))
      } else {
        await run('reset the worktree', 'Reset the worktree to a clean state.', {}, () => ({}))
        await run('auto generate docs', 'Auto-generate this worktree docs.', {}, () => ({}))
      }
    }
  }
  await run('init submodules recursively', 'Init submodules recursively.', {}, () => ({}))

  const receiptValid = d.malformedReceipt !== 'active task'
  const receiptOk = receipt(
    'Output',
    'Receipt: { active task, initialized worktree }',
    'is the active task receipt structure valid?',
    receiptValid,
  )
  if (!receiptOk) {
    return {
      ok: false,
      trace: exitChain(
        'run-failed',
        'the active task receipt is malformed',
        { lease: true, sourceLock: false, noRunRecord: false },
      ),
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Planning (plans/diagram/pipeline-planning.mmd)
// ---------------------------------------------------------------------------

const planningPhase = async () => {
  const held = { lease: true, sourceLock: false, noRunRecord: false }
  const MAX_ATTEMPTS = 2

  let scrapAttempt = 0
  let amendRound = 0
  let verdictIndex = 0
  let retryDepth = 0

  const planVerdictFor = (index) => {
    const verdicts = FAKE.codexPlanVerdict
    return verdicts[Math.min(index, verdicts.length - 1)]
  }

  planning: for (;;) {
    await run(
      'plan the task',
      'Read the task brief and write a plan file: task number, revision, and sections (id, title, body).',
      {},
      () => ({ task: 1, revision: 1, sections: [{ id: 'draft', title: 'Draft', body: 'Draft plan.' }] }),
      true,
    )

    const planValid = isFake()
      ? FAKE.malformedReceipt !== 'plan file'
      : realDecisions('plan file receipt validity')
    const planOk = receipt(
      'Output',
      'Receipt: { plan file: task, revision, sections[ id, title, body ] }',
      'is the plan file structure valid?',
      planValid,
    )
    if (!planOk) {
      return { ok: false, trace: exitChain('run-failed', 'the plan file is malformed', held) }
    }

    for (;;) {
      const review = await run(
        'codex reviews the plan',
        'Review the plan file and return a verdict (accept, amend, or scrap) with notes and any amendments.',
        {},
        () => ({ verdict: planVerdictFor(verdictIndex), notes: '', amendments: [] }),
        true,
      )

      const reviewValid = isFake()
        ? FAKE.malformedReceipt !== 'codex review'
        : realDecisions('codex review receipt validity')
      const reviewOk = receipt(
        'Output',
        'Receipt: { codex review: verdict, notes, amendments[] }',
        'is the review file structure valid?',
        reviewValid,
      )
      if (!reviewOk) {
        return { ok: false, trace: exitChain('run-failed', 'the codex review is malformed', held) }
      }

      const verdict = isFake() ? planVerdictFor(verdictIndex) : review.verdict
      verdictIndex += 1
      step('what is the review verdict?', verdict.toUpperCase())

      if (verdict === 'accept') break planning

      if (verdict === 'scrap') {
        scrapAttempt += 1
        const firstTimeScrap = scrapAttempt < MAX_ATTEMPTS
        step('First Time Scrap?', yesNo(firstTimeScrap))
        if (!firstTimeScrap) {
          step('Second Time Scrap')
          return { ok: false, trace: exitChain('plan-scrapped', 'codex scrapped the plan twice', held) }
        }
        await run(
          'script adds the codex scrap notes to the task brief',
          'Add the codex scrap notes to the task brief.',
          {},
          () => ({}),
        )
        enterRetry()
        retryDepth += 1
        continue planning
      }

      await run(
        'Try: script applies codex amendments to the plan',
        'Apply the codex amendments to the plan.',
        {},
        () => ({}),
      )
      amendRound += 1
      const roundsDone = amendRound >= MAX_ATTEMPTS
      step('2 amend rounds done?', yesNo(roundsDone))
      if (roundsDone) break planning
      enterRetry()
      retryDepth += 1
    }
  }

  while (retryDepth > 0) {
    leaveRetry()
    retryDepth -= 1
  }

  const finishedValid = isFake()
    ? FAKE.malformedReceipt !== 'finished plan'
    : realDecisions('finished plan receipt validity')
  const finishedOk = receipt(
    'Output',
    'Receipt: { plan file }',
    'is the finished plan receipt structure valid?',
    finishedValid,
  )
  if (!finishedOk) {
    return { ok: false, trace: exitChain('run-failed', 'the finished plan receipt is malformed', held) }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Implement and test (plans/diagram/pipeline-implementTest.mmd)
// ---------------------------------------------------------------------------

const implementTestPhase = async () => {
  const held = { lease: true, sourceLock: false, noRunRecord: false }
  const MAX_ATTEMPTS = 2
  const d = isFake() ? FAKE : realDecisions('implement and test decisions')
  const attempt = (arr, idx) => arr[Math.min(idx, arr.length - 1)]

  await run(
    'implement task',
    'Read the plan file and implement the task it describes: write the code changes.',
    {},
    () => ({ implemented: true }),
    true,
  )
  await run(
    'record implementation notes file to tasks.json',
    'Record the implementation notes file to tasks.json.',
    {},
    () => ({}),
  )

  let testAttempt = 0
  let codexTestAttempt = 0
  let testRetryDepth = 0

  testLoop: for (;;) {
    await run('commit if needed', 'Commit the worktree if it is dirty.', {}, () => ({}))
    await run('Try: run task tests', 'Run this task tests.', {}, () => ({}))
    const testsFail = attempt(d.taskTestsFail, testAttempt)
    step('do the tests fail?', yesNo(testsFail))

    if (testsFail) {
      testAttempt += 1
      const isFirstFail = testAttempt < MAX_ATTEMPTS
      step('First fail?', yesNo(isFirstFail))
      if (!isFirstFail) {
        step('2nd fail')
        return { ok: false, trace: exitChain('tests-red', 'task tests failed after 2 codebase fixes', held) }
      }

      await run(
        'fix the codebase',
        'Edit source files, never tests, so the failing task tests pass.',
        {},
        () => ({ fixed: true }),
        true,
      )
      const fixValid = d.malformedReceipt !== 'fix the codebase'
      const fixOk = receipt(
        'Output',
        'Receipt: { fixed }',
        'is the fix receipt structure valid?',
        fixValid,
      )
      if (!fixOk) {
        return { ok: false, trace: exitChain('run-failed', 'the fix receipt is malformed', held) }
      }
      enterRetry()
      testRetryDepth += 1
      continue testLoop
    }

    await run(
      'codex reviews tests against task details and plan file',
      "Review this task's tests against the task details and plan file. Flag them if they are wrong or assert nothing.",
      {},
      () => ({
        flagged: attempt(d.codexTestsFlagged, codexTestAttempt),
        reviewer: 'codex',
        testReviewFile: 'test-review.md',
      }),
      true,
    )
    const reviewValid = d.malformedReceipt !== 'test review'
    const reviewOk = receipt(
      'Output',
      'Receipt: { flagged, reviewer, test review file }',
      'is the test review receipt structure valid?',
      reviewValid,
    )
    if (!reviewOk) {
      return { ok: false, trace: exitChain('run-failed', 'the test review receipt is malformed', held) }
    }

    const flagged = attempt(d.codexTestsFlagged, codexTestAttempt)
    step('are the tests flagged?', yesNo(flagged))
    if (!flagged) break testLoop

    codexTestAttempt += 1
    const isFirstFlag = codexTestAttempt < MAX_ATTEMPTS
    step('First flagging?', yesNo(isFirstFlag))
    if (!isFirstFlag) {
      step('2nd flagging')
      return { ok: false, trace: exitChain('tests-flagged', 'codex flagged the tests twice', held) }
    }

    await run(
      'amend the tests',
      'Edit this task own tests to resolve codex flags. Never edit a test this task did not create, unless it is broken or asserts nothing.',
      {},
      () => ({ amended: true }),
      true,
    )
    const amendValid = d.malformedReceipt !== 'amend tests'
    const amendOk = receipt(
      'Output',
      'Receipt: { amended }',
      'is the amendment receipt structure valid?',
      amendValid,
    )
    if (!amendOk) {
      return { ok: false, trace: exitChain('run-failed', 'the amendment receipt is malformed', held) }
    }
    testAttempt += 1
    enterRetry()
    testRetryDepth += 1
  }

  while (testRetryDepth > 0) {
    leaveRetry()
    testRetryDepth -= 1
  }

  // Two boxes for the source repo lock, per rule 10: "can the source repo be locked?" reads
  // whether it's free, then "lock the source repo" takes it. Each has its own two-strike wait.
  let sourceHeldAttempt = 0
  let lockFailAttempt = 0
  let freeIndex = 0
  let lockIndex = 0
  let lockRetryDepth = 0

  lockLoop: for (;;) {
    const free = attempt(d.sourceRepoFree, freeIndex)
    freeIndex += 1
    step('can the source repo be locked?', yesNo(free))

    if (!free) {
      sourceHeldAttempt += 1
      const isFirstHeld = sourceHeldAttempt < MAX_ATTEMPTS
      step('First time held?', yesNo(isFirstHeld))
      if (!isFirstHeld) {
        step('2nd time held')
        return { ok: false, trace: exitChain('run-failed', 'the source repo lock is held by another owner', held) }
      }
      await run('Try: wait', 'Wait for the source repo lock to free up.', {}, () => ({}))
      enterRetry()
      lockRetryDepth += 1
      continue lockLoop
    }

    await run('Try: lock the source repo', 'Lock the source repo.', {}, () => ({}))
    const locked = attempt(d.lockSucceeds, lockIndex)
    lockIndex += 1
    step('did locking the source repo succeed?', yesNo(locked))
    if (locked) {
      held.sourceLock = true
      break lockLoop
    }

    lockFailAttempt += 1
    const isFirstLockFail = lockFailAttempt < MAX_ATTEMPTS
    step('First lock failure?', yesNo(isFirstLockFail))
    if (!isFirstLockFail) {
      step('2nd lock failure')
      return { ok: false, trace: exitChain('run-failed', 'the source repo lock could not be acquired', held) }
    }
    await run('Try: wait', 'Wait after losing the lock race.', {}, () => ({}))
    enterRetry()
    lockRetryDepth += 1
  }

  while (lockRetryDepth > 0) {
    leaveRetry()
    lockRetryDepth -= 1
  }

  const implValid = d.malformedReceipt !== 'finished implementation'
  const implOk = receipt(
    'Output',
    'Receipt: { finished implementation, source repo lock }',
    'is the finished implementation receipt structure valid?',
    implValid,
  )
  if (!implOk) {
    return { ok: false, trace: exitChain('run-failed', 'the finished implementation receipt is malformed', held) }
  }

  return { ok: true, sourceLockHeld: true }
}

// ---------------------------------------------------------------------------
// Rebase and merge (plans/diagram/pipeline-rebaseMerge.mmd)
// ---------------------------------------------------------------------------

const rebaseMergePhase = async () => {
  const held = { lease: true, sourceLock: true, noRunRecord: false }
  const d = isFake() ? FAKE : realDecisions('rebase and merge decisions')
  const attempt = (arr, idx) => arr[Math.min(idx, arr.length - 1)]

  let conflictAttempt = 0
  let suiteAttempt = 0
  let rebaseAttempt = 0
  let advanceAttempt = 0
  let mergeAttempt = 0
  let outerRetries = 0

  for (;;) {
    await run('Try: rebase onto the target branch if needed', 'Rebase this worktree onto the target branch if needed.', {}, () => ({}))
    let conflicted = attempt(d.rebase, rebaseAttempt) === 'conflict'
    step('did the rebase report conflicts?', yesNo(conflicted))
    rebaseAttempt += 1

    let innerRetries = 0
    for (;;) {
      if (conflicted) {
        conflictAttempt += 1
        const first = conflictAttempt < 2
        step('First conflict?', yesNo(first))
        if (!first) {
          step('2nd conflict?')
          return { ok: false, trace: exitChain('rebase-stuck', 'the rebase did not advance after 2 conflict fixes', held) }
        }
        await run(
          'fix conflicts',
          'Resolve the current rebase conflicts, deepest submodule first, root last. Report which files were resolved and which remain unresolved.',
          {},
          () => ({ resolved: true, unresolvedPaths: [] }),
          true,
        )
        const valid = d.malformedReceipt !== 'conflict fix'
        const ok = receipt('Output', 'Receipt: { resolved, unresolvedPaths }', 'is the conflict fix receipt structure valid?', valid)
        if (!ok) return { ok: false, trace: exitChain('run-failed', 'the conflict fix receipt is malformed', held) }
      }

      await run('commit if needed', 'Commit the worktree if it is dirty.', {}, () => ({}))
      await run('Try: continue replaying commits on top of the target branch', 'Continue replaying commits on top of the target branch.', {}, () => ({}))
      const advance = attempt(d.rebaseAdvance, advanceAttempt)
      const finished = advance === 'finished'
      step('is the rebase finished?', yesNo(finished))
      advanceAttempt += 1

      if (finished) {
        await run('Try: run the full suite', 'Run the full test suite.', {}, () => ({}))
        const suitePasses = attempt(d.fullSuitePasses, suiteAttempt)
        step('do all tests pass?', yesNo(suitePasses))
        if (suitePasses) break
        suiteAttempt += 1
        const first = suiteAttempt < 2
        step('First suite failure?', yesNo(first))
        if (!first) {
          step('2nd suite failure?')
          return { ok: false, trace: exitChain('suite-red', 'full suite still failing after 2 codebase fixes', held) }
        }
        await run(
          'fix the codebase so the full suite passes',
          'The full suite is still failing after the rebase. Fix the source code, not the tests, so every test passes.',
          {},
          () => ({ fixed: true }),
          true,
        )
        const valid = d.malformedReceipt !== 'fix the full suite'
        const ok = receipt('Output', 'Receipt: { fixed }', 'is the suite fix receipt structure valid?', valid)
        if (!ok) return { ok: false, trace: exitChain('run-failed', 'the suite fix receipt is malformed', held) }
        conflicted = false
        enterRetry()
        innerRetries += 1
        continue
      }

      conflicted = attempt(d.rebase, rebaseAttempt) === 'conflict'
      enterRetry()
      innerRetries += 1
      step('did the rebase report conflicts?', yesNo(conflicted))
      rebaseAttempt += 1
    }
    while (innerRetries > 0) {
      leaveRetry()
      innerRetries -= 1
    }

    const fenceHeld = d.fenceHeld
    step("did every change stay inside the task's owned files?", yesNo(fenceHeld))
    if (!fenceHeld) return { ok: false, trace: exitChain('fence-violation', "a step changed a file the task does not own", held) }

    await run('Try: merge worktrees and submodules, no fast-forward', 'Merge worktrees and submodules, no fast-forward.', {}, () => ({}))
    const merged = attempt(d.mergeLands, mergeAttempt)
    step('did the merge land?', yesNo(merged))
    if (merged) {
      while (outerRetries > 0) {
        leaveRetry()
        outerRetries -= 1
      }
      break
    }
    mergeAttempt += 1
    const firstMerge = mergeAttempt < 2
    step('First merge failure?', yesNo(firstMerge))
    if (!firstMerge) {
      step('2nd merge failure?')
      return { ok: false, trace: exitChain('merge-failed', 'the merge did not land twice', held) }
    }
    conflictAttempt = 0
    suiteAttempt = 0
    enterRetry()
    outerRetries += 1
  }

  const mergeValid = d.malformedReceipt !== 'merge'
  const ok = receipt('Output', 'Receipt: { merge commit hashes, modified files }', 'is the merge receipt structure valid?', mergeValid)
  if (!ok) return { ok: false, trace: exitChain('run-failed', 'the merge receipt is malformed', held) }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Driver — runs the four phases in order, then the success tail of
// plans/diagram/pipeline-exitWorkflow.mmd. A phase returning { ok: false } ends
// the run with the trace it already produced.
// ---------------------------------------------------------------------------

const taskNumber = isFake() ? FAKE.taskNumber : realDecisions('task number')
trace.push(`Run start: Task Num [${taskNumber}]`)
log(trace[0])

const driver = async () => {
  banner('preamble')
  const preambleResult = await preamblePhase()
  if (!preambleResult.ok) return preambleResult.trace

  banner('planning')
  const planningResult = await planningPhase()
  if (!planningResult.ok) return planningResult.trace

  banner('implement and test')
  const implementResult = await implementTestPhase()
  if (!implementResult.ok) return implementResult.trace

  banner('rebase and merge')
  const rebaseResult = await rebaseMergePhase()
  if (!rebaseResult.ok) return rebaseResult.trace

  banner('exit workflow')
  await run('record merge commit hashes to tasks.json', 'Record merge commit hashes to tasks.json.', {}, () => ({}))
  await run('write exit type completed to tasks.json', 'Write exit type completed to tasks.json.', {}, () => ({}))
  await run('record modified files to tasks.json', 'Record modified files to tasks.json.', {}, () => ({}))
  await run(
    'clean up worktrees, leases, persistence refs and source lock',
    'Clean up worktrees, leases, persistence refs and the source lock.',
    {},
    () => ({}),
  )
  await run('build the closure note from the recorded run', 'Build the closure note from the recorded run.', {}, () => ({}))
  await run('mark task inactive in tasks.json', 'Mark task inactive in tasks.json.', {}, () => ({}))
  await run(
    'move task to completedTasks.json and update tasks blocked by it',
    'Move task to completedTasks.json and update tasks blocked by it.',
    {},
    () => ({}),
  )
  await run('report the closure note', 'Report the closure note.', {}, () => ({}))
  step('stop')

  return trace
}

return driver()
