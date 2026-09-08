# Task 146 plan — full-suite green gate in the rebase-test stage, with a fix loop

## Summary

The rebase-test stage in `skills/tackle-tasks/task.workflow.js` already rebases
every submodule layer deepest-first and the parent (task 142/143/145 work),
already discovers each repo's own test command per-layer via `discoverTestPolicy`
inside `scripts/mergeTaskWorktrees.ts` (`rebaseAndTestSubmoduleLayer` and
`rebaseParentOntoSourceAndTest`), and already routes live conflicts to a merge
agent (task 145). What is missing, and what this task adds:

1. A `MAX_REBASE_FIX_ROUNDS` constant, distinct from `MAX_FIX_ROUNDS`.
2. A fix-agent brief/schema/dispatcher for a RED (`tests-failed`) layer, and a
   bounded retry loop in `runRebaseTest` that dispatches it, then re-runs the
   whole rebase/test walk (the walk already re-tests every layer on every
   call — that satisfies "one rule governs all rebase testing" for free).
3. Two discrete `lastFailure` strings, exactly as named in the brief:
   `"layer still red after MAX_REBASE_FIX_ROUNDS"` and `"untested layer"`.
4. A `MAX_LAPS` constant and a pure `hasLapRemaining` guard function in
   `scripts/runMergePhase.ts`, the 2-lap ceiling task 147's not-yet-built merge
   queue must carry forward.

`scripts/mergeTaskWorktrees.ts` and `plans/task-86-spec.md` need no edits (see
"Files needing no edit" below).

### Scope boundaries this plan deliberately does not cross

- **No merge queue in `scripts/runMergePhase.ts`.** The brief's own
  DEFINITION line says a lap is "one full pass of the merge queue **built in
  task 147**," and its NOTE FOR TASK 147 says task 147 "rewrites
  `scripts/runMergePhase.ts` **from scratch**" and must carry the ceiling
  "into the **new** merge scheduling queue." No queue, task list, or
  per-task attempt loop exists anywhere in the current codebase today (the
  file's only CLI entry point, `runAsCli`, runs one merge command for one
  already-prepared run, not a queue of tasks) — building one now would mean
  designing task 147's queue early, on top of a file task 147 is going to
  delete and replace outright. This task's job, per the brief, is only to
  store the ceiling and expose it as a primitive (`MAX_LAPS`,
  `hasLapRemaining`) for that future queue to import; it does not add
  requeue/removal/attempt-tracking behavior, because there is no queue yet
  for that behavior to attach to.
- **No new behavioral test file for per-repository test discovery.** The
  brief's own metadata line reads "tests: skip" for this task, and the
  plan's Verification section already notes `skills/tackle-tasks/task.workflow.js`
  has no direct test harness in this repo. The file that *would* carry
  behavioral coverage for `discoverTestPolicy`'s per-repository behavior is
  `tests/mergeTaskWorktrees.test.ts` — not in this task's `files` list, and
  `scripts/mergeTaskWorktrees.ts` needs no code changes here (see "Files
  needing no edit" below), so there is no new discovery logic in this task
  for a new test to cover. `tests/runMergePhase.test.ts`, which *is* in this
  task's files, gets the one behavioral test this task's own new code
  needs: `test_hasLapRemainingAllowsExactlyTwoLapsThenStops` (Edit 8).

---

## Edits to `skills/tackle-tasks/task.workflow.js`

### Edit 1 — add `MAX_REBASE_FIX_ROUNDS`, line 6

Current text (line 6):

```
const MAX_FIX_ROUNDS = ARGS.maxRounds ?? 3
```

Becomes (insert a new line 7 immediately after):

```
const MAX_FIX_ROUNDS = ARGS.maxRounds ?? 3
const MAX_REBASE_FIX_ROUNDS = ARGS.maxRebaseFixRounds ?? 3
```

This mirrors `MAX_FIX_ROUNDS`'s own declaration style (an `ARGS`-overridable
constant with a default of 3) while keeping it a fully separate binding, per
the brief's "must be tunable apart."

### Edit 2 — add `REBASE_FIX_SCHEMA`, after line 72

Current text (lines 65–74):

```
const MERGE_CONFLICT_SCHEMA = {
  type: 'object',
  properties: {
    resolved: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['resolved', 'summary'],
}

const fileRetryPreamble = (missingFiles) =>
```

Becomes:

```
const MERGE_CONFLICT_SCHEMA = {
  type: 'object',
  properties: {
    resolved: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['resolved', 'summary'],
}

const REBASE_FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['fixed', 'summary'],
}

const fileRetryPreamble = (missingFiles) =>
```

### Edit 3 — add `rebaseFixBrief`, after line 278

Current text (lines 274–280):

```
You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset anything you did not create; to run
\`git rebase --continue\` or \`git rebase --abort\` yourself; or to leave an edit
in a different repository uncommitted. Returning resolved false is a correct
outcome when a conflict genuinely cannot be resolved, not a failure.`

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
```

(Note: the literal source has real backticks, not escaped ones — the escaping
above is only so this plan file's own fences don't break; apply the edit using
the literal characters from the live file.)

Becomes (insert the new brief between the closing backtick of
`mergeConflictBrief` and the `retryAgent` comment):

```
You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset anything you did not create; to run
`git rebase --continue` or `git rebase --abort` yourself; or to leave an edit
in a different repository uncommitted. Returning resolved false is a correct
outcome when a conflict genuinely cannot be resolved, not a failure.`

const rebaseFixBrief = (checkoutPath, occurrenceId, testOutput, forbiddenPaths) => `The test suite for layer "${occurrenceId === '' ? 'root' : occurrenceId}" is RED after a rebase, in ${checkoutPath}. Fix the cause.

Carry out every step below, in order, from top to bottom.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

Failure output from the test run:
${testOutput}

You may READ anything, anywhere in the tree. You may EDIT any file inside ${checkoutPath} — the failing test, or the code it covers. Do not edit any file outside ${checkoutPath}. These paths inside ${checkoutPath} are OTHER layers (separate occurrences) and are out of scope even though they sit on disk under ${checkoutPath} — do not edit anything inside them: ${forbiddenPaths.length === 0 ? '(none)' : forbiddenPaths.join(', ')}

fix the cause of the failure

run(git -C ${checkoutPath} add -A)
run(git -C ${checkoutPath} commit -m "task ${N}: fix rebase-test failure in ${occurrenceId === '' ? 'root' : occurrenceId}")
// rebase needs a clean tree; this commit is never undone — it survives for the next lap

if git -C ${checkoutPath} status --porcelain prints nothing (the fix is committed):
    return {fixed: true, summary: what you changed}
else:
    return {fixed: false, summary: why the tree is still dirty}

You are forbidden to weaken, delete, or stub out a test or the code it covers
to make the failure disappear; to edit any file outside ${checkoutPath}, or
inside a layer listed above as out of scope; to force-push or hard-reset
anything you did not create; or to leave your edit uncommitted.`

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
```

(`rebaseFixBrief` deliberately mirrors `mergeConflictBrief`'s
imperative-steps / "You are forbidden to" structure, and reuses the
`occurrenceId === '' ? 'root' : occurrenceId` display idiom already used at
line 434's `commitOccurrenceChanges`. Edits are scoped to `checkoutPath` only —
unlike `mergeConflictBrief`, which allows cross-layer edits — because the
brief calls this "a fix agent scoped to that layer." `forbiddenPaths` exists
because layer-scoping by `checkoutPath` alone is not enough: when
`occurrenceId` is the parent (`''`), `checkoutPath` is the whole worktree,
and every submodule's checkout physically lives inside that same directory
tree. Without an explicit list of excluded nested-layer paths, "any file
inside `checkoutPath`" for the parent would silently include every
submodule too. `forbiddenPaths` is computed by `descendantCheckoutPaths` in
Edit 5, which resolves to an empty list for a leaf submodule with no nested
layers, so this text has no effect there beyond the harmless `(none)`.)

### Edit 4 — add `runRebaseFixAgent`, after line 466

Current text (lines 463–467, the blank line 467 included for anchoring):

```
const runMergeConflictAgent = (checkoutPath, conflictedFilePaths) => retryAgent(() => agent(
  mergeConflictBrief(checkoutPath, conflictedFilePaths),
  { label: `rebase-conflict:${N}`, phase: `${N} Rebase-Test`, schema: MERGE_CONFLICT_SCHEMA },
))

```

Becomes:

```
const runMergeConflictAgent = (checkoutPath, conflictedFilePaths) => retryAgent(() => agent(
  mergeConflictBrief(checkoutPath, conflictedFilePaths),
  { label: `rebase-conflict:${N}`, phase: `${N} Rebase-Test`, schema: MERGE_CONFLICT_SCHEMA },
))

const runRebaseFixAgent = (checkoutPath, occurrenceId, testOutput, forbiddenPaths) => retryAgent(() => agent(
  rebaseFixBrief(checkoutPath, occurrenceId, testOutput, forbiddenPaths),
  { label: `rebase-fix:${N}`, phase: `${N} Rebase-Test`, schema: REBASE_FIX_SCHEMA },
))

```

### Edit 5 — rewrite `runRebaseTest`, lines 507–554

Current text (lines 507–554, exactly as read):

```
const runRebaseTest = async () => {
  log(`task ${N}: rebase-test stage`)
  if (!preparedTask) preparedTask = await loadPreparedTask()
  const { execFileSync } = await import('node:child_process')
  const { join } = await import('node:path')
  const { rebaseSubmoduleLayersDeepestFirst, rebaseParentOntoSourceAndTest, uncommittedChangedFiles } = await import('./scripts/mergeTaskWorktrees.ts')
  const { createEmptyResolutionManifest } = await import('./scripts/resolutionRequests.ts')
  const worktreePath = preparedTask.repoRoot
  const manifest = { repositoryManifest: ARGS.repositoryManifest, resolutionManifest: createEmptyResolutionManifest() }
  const occurrences = manifest.repositoryManifest.occurrences
  const rootOccurrence = occurrences.find((o) => o.occurrenceId === '')
  const sourceBranch = rootOccurrence.baseBranch
  const submodulePaths = occurrences
    .filter((o) => o.parentOccurrenceId === '')
    .map((o) => o.pathInParent)
    .filter((p) => p !== null)
  const checkoutPaths = taskWorktreeCheckoutPaths(occurrences, worktreePath, join)
  const occurrencesDeepestFirst = [...occurrences].sort((a, b) => b.depth - a.depth)
  const fenceViolations = []

  let layerWalk = rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, true)
  while (layerWalk.stoppedAt !== null && layerWalk.stoppedAt.status === 'conflicted') {
    const { occurrenceId, conflictedFilePaths } = layerWalk.stoppedAt
    const outcome = await advanceLiveConflict(execFileSync, uncommittedChangedFiles, occurrencesDeepestFirst, checkoutPaths, occurrenceId, conflictedFilePaths, fenceViolations)
    if (!outcome.advanced) {
      return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: outcome.lastFailure, cleanupFailure: outcome.cleanupFailure, occurrenceId, fenceViolations }
    }
    layerWalk = rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, true)
  }
  if (layerWalk.stoppedAt !== null) {
    const stopped = layerWalk.stoppedAt
    return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: stopped.status, occurrenceId: stopped.occurrenceId, layerOutcome: stopped, fenceViolations }
  }

  let parentOutcome = rebaseParentOntoSourceAndTest('', worktreePath, sourceBranch, submodulePaths, manifest.resolutionManifest, true)
  while (parentOutcome.status === 'conflicted') {
    const outcome = await advanceLiveConflict(execFileSync, uncommittedChangedFiles, occurrencesDeepestFirst, checkoutPaths, '', parentOutcome.conflictedFilePaths, fenceViolations)
    if (!outcome.advanced) {
      return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: outcome.lastFailure, cleanupFailure: outcome.cleanupFailure, occurrenceId: '', fenceViolations }
    }
    parentOutcome = rebaseParentOntoSourceAndTest('', worktreePath, sourceBranch, submodulePaths, manifest.resolutionManifest, true)
  }
  if (parentOutcome.status !== 'rebased-and-tested') {
    return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: parentOutcome.status, occurrenceId: '', parentOutcome, fenceViolations }
  }

  return { stage: 'rebase-test', task: N, status: 'green', fenceViolations }
}
```

Becomes:

```
const runRebaseTest = async () => {
  log(`task ${N}: rebase-test stage`)
  if (!preparedTask) preparedTask = await loadPreparedTask()
  const { execFileSync } = await import('node:child_process')
  const { join, relative } = await import('node:path')
  const { rebaseSubmoduleLayersDeepestFirst, rebaseParentOntoSourceAndTest, uncommittedChangedFiles } = await import('./scripts/mergeTaskWorktrees.ts')
  const { createEmptyResolutionManifest } = await import('./scripts/resolutionRequests.ts')
  const worktreePath = preparedTask.repoRoot
  const manifest = { repositoryManifest: ARGS.repositoryManifest, resolutionManifest: createEmptyResolutionManifest() }
  const occurrences = manifest.repositoryManifest.occurrences
  const rootOccurrence = occurrences.find((o) => o.occurrenceId === '')
  const sourceBranch = rootOccurrence.baseBranch
  const submodulePaths = occurrences
    .filter((o) => o.parentOccurrenceId === '')
    .map((o) => o.pathInParent)
    .filter((p) => p !== null)
  const checkoutPaths = taskWorktreeCheckoutPaths(occurrences, worktreePath, join)
  const occurrencesDeepestFirst = [...occurrences].sort((a, b) => b.depth - a.depth)
  const fenceViolations = []
  const fixRoundsByOccurrenceId = new Map()
  const consumeFixRound = (occurrenceId) => {
    const used = (fixRoundsByOccurrenceId.get(occurrenceId) ?? 0) + 1
    fixRoundsByOccurrenceId.set(occurrenceId, used)
    return used
  }
  // A parent's checkoutPath contains every submodule's checkoutPath; exclude those nested layers explicitly.
  const descendantCheckoutPaths = (occurrenceId) => {
    const ownPath = checkoutPaths.get(occurrenceId)
    return occurrencesDeepestFirst
      .filter((o) => o.occurrenceId !== occurrenceId)
      .map((o) => checkoutPaths.get(o.occurrenceId))
      .filter((path) => {
        const rel = relative(ownPath, path)
        return rel !== '' && !rel.startsWith('..')
      })
  }
  // Verifies a fix attempt before any rebase/test cycle re-runs: unfixed, dirty, or another layer touched all fail.
  const attemptRebaseFix = async (occurrenceId, checkoutPath, testOutput) => {
    const otherOccurrences = occurrencesDeepestFirst.filter((o) => o.occurrenceId !== occurrenceId)
    const beforeOids = otherOccurrences.map((o) => [o.occurrenceId, readHeadOid(execFileSync, checkoutPaths.get(o.occurrenceId))])
    const fixOutcome = await runRebaseFixAgent(checkoutPath, occurrenceId, testOutput, descendantCheckoutPaths(occurrenceId))
    let otherLayerTouched = false
    for (const [otherId, beforeOid] of beforeOids) {
      const otherPath = checkoutPaths.get(otherId)
      const touchedPaths = new Set([...changedPathsSinceOid(execFileSync, otherPath, beforeOid), ...uncommittedChangedFiles(otherPath)])
      for (const path of touchedPaths) {
        fenceViolations.push({ occurrenceId: otherId, path })
        otherLayerTouched = true
      }
    }
    const ownCheckoutClean = uncommittedChangedFiles(checkoutPath).length === 0
    return fixOutcome != null && fixOutcome.fixed === true && ownCheckoutClean && !otherLayerTouched
  }

  let layerWalk = rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, true)
  while (layerWalk.stoppedAt !== null && (layerWalk.stoppedAt.status === 'conflicted' || layerWalk.stoppedAt.status === 'tests-failed')) {
    const stopped = layerWalk.stoppedAt
    if (stopped.status === 'conflicted') {
      const { occurrenceId, conflictedFilePaths } = stopped
      const outcome = await advanceLiveConflict(execFileSync, uncommittedChangedFiles, occurrencesDeepestFirst, checkoutPaths, occurrenceId, conflictedFilePaths, fenceViolations)
      if (!outcome.advanced) {
        return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: outcome.lastFailure, cleanupFailure: outcome.cleanupFailure, occurrenceId, fenceViolations }
      }
    } else {
      const { occurrenceId, checkoutPath, testOutput } = stopped
      let fixSucceeded = false
      while (!fixSucceeded) {
        if (consumeFixRound(occurrenceId) > MAX_REBASE_FIX_ROUNDS) {
          return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: 'layer still red after MAX_REBASE_FIX_ROUNDS', occurrenceId, fenceViolations }
        }
        fixSucceeded = await attemptRebaseFix(occurrenceId, checkoutPath, testOutput)
      }
    }
    layerWalk = rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, true)
  }
  if (layerWalk.stoppedAt !== null) {
    const stopped = layerWalk.stoppedAt
    const lastFailure = stopped.status === 'untested' ? 'untested layer' : stopped.status
    return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure, occurrenceId: stopped.occurrenceId, layerOutcome: stopped, fenceViolations }
  }

  let parentOutcome = rebaseParentOntoSourceAndTest('', worktreePath, sourceBranch, submodulePaths, manifest.resolutionManifest, true)
  while (parentOutcome.status === 'conflicted' || parentOutcome.status === 'tests-failed') {
    if (parentOutcome.status === 'conflicted') {
      const outcome = await advanceLiveConflict(execFileSync, uncommittedChangedFiles, occurrencesDeepestFirst, checkoutPaths, '', parentOutcome.conflictedFilePaths, fenceViolations)
      if (!outcome.advanced) {
        return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: outcome.lastFailure, cleanupFailure: outcome.cleanupFailure, occurrenceId: '', fenceViolations }
      }
    } else {
      let fixSucceeded = false
      while (!fixSucceeded) {
        if (consumeFixRound('') > MAX_REBASE_FIX_ROUNDS) {
          return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: 'layer still red after MAX_REBASE_FIX_ROUNDS', occurrenceId: '', fenceViolations }
        }
        fixSucceeded = await attemptRebaseFix('', worktreePath, parentOutcome.testOutput)
      }
    }
    parentOutcome = rebaseParentOntoSourceAndTest('', worktreePath, sourceBranch, submodulePaths, manifest.resolutionManifest, true)
  }
  if (parentOutcome.status !== 'rebased-and-tested') {
    const lastFailure = parentOutcome.status === 'untested' ? 'untested layer' : parentOutcome.status
    return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure, occurrenceId: '', parentOutcome, fenceViolations }
  }

  return { stage: 'rebase-test', task: N, status: 'green', fenceViolations }
}
```

`readHeadOid` and `changedPathsSinceOid` are the existing module-level
helpers at lines 410 and 412 (already used by `advanceLiveConflict`) — no
new import is needed, since `runRebaseTest` lives in the same file.

Why this satisfies the brief's rules:

- **RED layer → fix agent, verified, → re-run.** `tests-failed` now stays inside
  the walk's `while` loop instead of falling through to an immediate `blocked`
  return; the branch dispatches `attemptRebaseFix` in an inner retry loop,
  and only once it reports success does the outer loop re-invoke
  `rebaseSubmoduleLayersDeepestFirst` (or `rebaseParentOntoSourceAndTest`)
  from scratch. Because that call always re-discovers and re-tests every
  layer from the top (no caching, no dirty flags anywhere in
  `mergeTaskWorktrees.ts`), a fix commit to one layer is automatically
  re-verified across the whole tree on the next iteration — this is exactly
  "ONE RULE GOVERNS ALL REBASE TESTING," reusing the loop-and-recheck idiom
  task 145 already established for conflicts, rather than inventing a
  second mechanism.
- **A fix attempt is verified before it is trusted.** `attemptRebaseFix`
  does not take the agent's self-report at face value: it requires
  `fixOutcome.fixed === true`, requires `checkoutPath` itself to actually be
  clean (`uncommittedChangedFiles(checkoutPath).length === 0`), and requires
  that no *other* occurrence changed (see next bullet) — all three, checked
  in code, before the outer loop is allowed to re-run the walk. An attempt
  that fails any of those checks does not advance; the inner
  `while (!fixSucceeded)` loop consumes another round via `consumeFixRound`
  and redispatches `attemptRebaseFix` again on the *same* `stoppedAt`,
  without invoking `rebaseSubmoduleLayersDeepestFirst`/
  `rebaseParentOntoSourceAndTest` — no rebase/test cycle is spent on an
  attempt that already failed verification. Exhausting
  `MAX_REBASE_FIX_ROUNDS` inside that inner loop returns
  `'layer still red after MAX_REBASE_FIX_ROUNDS'`, identical to the
  brief's FAILURE CONTRACT wording.
- **Fix-agent edits really are scoped to one layer.** A parent's
  `checkoutPath` is the whole worktree, which contains every submodule's
  checkout on disk — `mergeConflictBrief`'s cross-layer edits are allowed
  there by design, but `rebaseFixBrief` is not supposed to allow them, so
  containment inside `checkoutPath` alone cannot be the boundary.
  `attemptRebaseFix` snapshots every *other* occurrence's `HEAD` (via the
  existing `readHeadOid` helper, the same one `advanceLiveConflict` already
  uses) before dispatch, then afterward checks each other occurrence for
  both new commits (`changedPathsSinceOid`) and uncommitted changes
  (`uncommittedChangedFiles`) — exactly the two checks
  `advanceLiveConflict` already runs for cross-layer edits, reused here
  instead of invented fresh. Any touched path on another occurrence is
  recorded in `fenceViolations` (the same array `advanceLiveConflict`
  already reports through) and fails the attempt, so it is retried rather
  than silently accepted. `descendantCheckoutPaths` additionally lists
  every nested occurrence's checkout path in the brief itself as
  explicitly out of scope, so the agent is told the boundary, not just
  caught after the fact.
- **A submodule change during a parent-level fix restarts the whole
  walk, not just the parent.** Because `attemptRebaseFix` treats any
  change to another occurrence as a failed attempt (never as an accepted
  cross-layer edit), a parent-scoped fix can never silently carry a
  submodule change forward into a parent-only retry — the attempt fails
  verification, the inner loop retries the *same* parent-level fix, and
  the walk is never re-run until the parent's own checkout is the only one
  that changed. If the fix genuinely required a submodule change, the
  agent's edit is rejected and the layer stays red rather than the
  submodule change going untested.
- **Bounded by `MAX_REBASE_FIX_ROUNDS`, not `MAX_FIX_ROUNDS`.** `consumeFixRound`
  tracks attempts per `occurrenceId` in a `Map` scoped to one `runRebaseTest`
  call (one lap's attempts). The check happens before each dispatch inside
  the inner `while (!fixSucceeded)` loop: three rounds are allowed (`used`
  from 1..3 passes), a fourth-round detection (`used` = 4 > 3) fails the
  layer. `MAX_FIX_ROUNDS` (the implementer's constant, used inside
  `workerBrief`) is never referenced here.
- **Both required failure strings, verbatim.** `'layer still red after MAX_REBASE_FIX_ROUNDS'`
  and `'untested layer'` appear exactly as quoted in the brief's FAILURE
  CONTRACT paragraph, each in both the submodule-layer path and the parent
  path.
- **Untested is not subjected to the fix loop.** `'untested'` is deliberately
  excluded from both `while` conditions (`... === 'conflicted' || ... === 'tests-failed'`),
  so it always falls through to the terminal `if` block below the loop and
  is reported immediately as `'untested layer'` — there is no test command
  for a fix agent to act on for that status, matching "An UNTESTED layer …
  never counts as green" without inventing work for the fix agent to do.
- **Every layer green before merge.** Unchanged: the function only reaches
  `status: 'green'` after both the submodule walk's `stoppedAt` is `null`
  and the parent's outcome is `'rebased-and-tested'`.
- **Fix commits are never left uncommitted, and never left in another
  layer.** `rebaseFixBrief` requires the agent itself to `git add -A` and
  `git commit` inside `checkoutPath` before returning, mirroring
  `workerBrief`'s agent-driven commit pattern (as opposed to
  `mergeConflictBrief`, whose commits are driven by code in
  `commitOccurrenceChanges` because that path allows cross-layer edits and
  this one does not); `attemptRebaseFix`'s own-checkout cleanliness check
  and other-occurrence fence check verify both halves of that requirement
  independently of the agent's self-report.

---

## Files needing no edit

### `scripts/mergeTaskWorktrees.ts`

No changes. Already satisfies every rule this task adds on top of:

- **Per-repository test discovery, not hard-coded.** `rebaseAndTestSubmoduleLayer`
  (line 295) calls `discoverTestPolicy(occurrenceId, checkoutPath, resolutionManifest)`
  and `rebaseParentOntoSourceAndTest` (line 370) calls
  `discoverTestPolicy(occurrenceId, worktreePath, resolutionManifest)` — each
  call is scoped to that occurrence's own `checkoutPath`/`worktreePath`, never
  a single hard-coded root command.
- **Untested is a distinct status, never green.** Both functions return
  `status: "untested"` when `testPolicyResult.status === "needsResolution"`
  (lines 296–297 and 371–372), separate from `"tests-failed"` and from the
  success status `"rebased-and-tested"`/`"rebased-and-tested"`.
- **No per-layer green flags, no staleness bookkeeping.**
  `rebaseSubmoduleLayersDeepestFirst` (line 320) calls
  `discoverRepositoryTree` and re-walks every submodule occurrence fresh on
  every invocation; there is no cache or "already tested" flag stored between
  calls, so re-invoking it after a fix commit re-tests every layer, exactly
  as the brief requires.

### `plans/task-86-spec.md`

No changes. This is the chain's read-only design record (`@plans/task-86-spec.md`
is included in this task's files only so the brief can inline it and the
implementer can read it) — it is not a target of this task's edits.

---

## Edits to `scripts/runMergePhase.ts`

### Edit 6 — add `MAX_LAPS` and `hasLapRemaining`, after line 26

Current text (lines 25–28):

```
export type MergeFailure = { repo: string; failedCommand: string; conflicts: unknown[]; error: string };
export type MergePhaseVerdict = { status: "merged" | "blocked"; result: unknown; failure: MergeFailure | null };

export function buildMergeOutcomes(steps: StepOutputs) {
```

Becomes:

```
export type MergeFailure = { repo: string; failedCommand: string; conflicts: unknown[]; error: string };
export type MergePhaseVerdict = { status: "merged" | "blocked"; result: unknown; failure: MergeFailure | null };

// Fixed 2-lap ceiling; task 147's queue must carry it forward (see task-86-spec.md, Serial tail).
export const MAX_LAPS = 2;

export function hasLapRemaining(lapsAttempted: number): boolean {
    return lapsAttempted < MAX_LAPS;
}

export function buildMergeOutcomes(steps: StepOutputs) {
```

`hasLapRemaining(0)` and `hasLapRemaining(1)` are `true` (a task that has
attempted 0 or 1 laps may still be retried); `hasLapRemaining(2)` is `false`
(a task that has attempted — and, by construction, failed — its second lap is
"considered failed, is removed from the queue, and never merges," per the
brief). This is a self-contained, testable primitive for task 147's queue to
import; it does not add a queue, since building the queue is explicitly task
147's job ("built in task 147," per the chain-goal definition of "lap").

---

## Edits to `tests/runMergePhase.test.ts`

### Edit 7 — widen the import, line 4

Current text (line 4):

```
import { buildMergeOutcomes, judgeMergeRun, resolveMergeVerdict, type MergePhaseVerdict, type MergeRetryDeps } from "../scripts/runMergePhase.ts";
```

Becomes:

```
import { buildMergeOutcomes, hasLapRemaining, judgeMergeRun, MAX_LAPS, resolveMergeVerdict, type MergePhaseVerdict, type MergeRetryDeps } from "../scripts/runMergePhase.ts";
```

### Edit 8 — add a test for the ceiling, after line 40

Current text (lines 30–41):

```
test("test_buildMergeOutcomesTreatsEveryMissingStepAsZero", () => {
    assert.deepEqual(buildMergeOutcomes({}), {
        doneCount: 0,
        partialCount: 0,
        blockedCount: 0,
        needsClarificationCount: 0,
        requeueCount: 0,
        testReceipts: [],
        reviewHandoffs: [],
    });
});

test("test_judgeMergeRunReportsMergedWhenTheScriptExitsCleanWithNoConflicts", () => {
```

Becomes:

```
test("test_buildMergeOutcomesTreatsEveryMissingStepAsZero", () => {
    assert.deepEqual(buildMergeOutcomes({}), {
        doneCount: 0,
        partialCount: 0,
        blockedCount: 0,
        needsClarificationCount: 0,
        requeueCount: 0,
        testReceipts: [],
        reviewHandoffs: [],
    });
});

test("test_hasLapRemainingAllowsExactlyTwoLapsThenStops", () => {
    assert.equal(MAX_LAPS, 2);
    assert.equal(hasLapRemaining(0), true);
    assert.equal(hasLapRemaining(1), true);
    assert.equal(hasLapRemaining(2), false);
});

test("test_judgeMergeRunReportsMergedWhenTheScriptExitsCleanWithNoConflicts", () => {
```

---

## Verification

Run from the repo root (`/Users/matkatmusicllc/Programming/taskTools-86`).

1. `npm test`
   Expected: exit code 0, no failing tests — includes the existing
   `runMergePhase.test.ts` suite plus the new `test_hasLapRemainingAllowsExactlyTwoLapsThenStops`
   test. (Per project convention, `npm test` — not `bun test` — is the suite
   runner; `bun test` reports one unrelated false failure in
   `mergeTaskWorktrees`.)

2. `npx tsc --noEmit`
   Expected: no type errors — confirms `MAX_LAPS`/`hasLapRemaining`'s export
   and the widened import in `tests/runMergePhase.test.ts` typecheck cleanly.

3. `node -e "const s=require('fs').readFileSync('skills/tackle-tasks/task.workflow.js','utf8'); const o=(s.match(/{/g)||[]).length,c=(s.match(/}/g)||[]).length; console.log(o,c,o===c)"`
   Expected: prints two equal numbers followed by `true` — confirms the five
   edits to `task.workflow.js` (a file with no direct test harness in this
   repo) leave braces balanced.

4. `rg -c "MAX_REBASE_FIX_ROUNDS" skills/tackle-tasks/task.workflow.js`
   Expected: `3` (the declaration plus the two `> MAX_REBASE_FIX_ROUNDS`
   comparisons, one per layer/parent branch).

5. `rg -c "runRebaseFixAgent" skills/tackle-tasks/task.workflow.js`
   Expected: `2` (the declaration plus its one call site inside
   `attemptRebaseFix`, itself called from both the submodule and parent
   branches).

6. `rg -c "layer still red after MAX_REBASE_FIX_ROUNDS" skills/tackle-tasks/task.workflow.js`
   Expected: `2` (one per branch's exhausted-rounds return).

7. `rg -c "'untested layer'" skills/tackle-tasks/task.workflow.js`
   Expected: `2` (one per branch's terminal `if` block).

8. `rg -c "MAX_LAPS" scripts/runMergePhase.ts`
   Expected: `2` (the `export const` declaration plus its use inside
   `hasLapRemaining`).

9. `rg -c "attemptRebaseFix" skills/tackle-tasks/task.workflow.js`
   Expected: `3` (the declaration plus one call site in the submodule
   branch's inner retry loop and one in the parent branch's).

10. `rg -c "descendantCheckoutPaths" skills/tackle-tasks/task.workflow.js`
    Expected: `2` (the declaration plus its one call site inside
    `attemptRebaseFix`).

11. `rg -c "fenceViolations.push" skills/tackle-tasks/task.workflow.js`
    Expected: `3` (the two existing pushes inside `advanceLiveConflict`
    plus the one new push inside `attemptRebaseFix`).
