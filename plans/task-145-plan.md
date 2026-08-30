# Task 145 plan — rebase-test stage: merge-conflict agent fed from `collectConflictedRebasePaths`

## Design summary (read this before the edit list)

`skills/tackle-tasks/task.workflow.js` runs one background process per task, with
`process.cwd()` equal to that task's own worktree (this is already true for
`runImplement`, which does `git -C preparedTask.repoRoot rev-parse HEAD` and
`git -C <worktree> diff --name-only <base>..HEAD` per the spec — `preparedTask.repoRoot`
*is* the worktree).

The rebase-test stage needs to know, for every occurrence (parent + submodules), the
branch to rebase onto (`baseBranch`) and which paths are direct submodules of the
root. That data cannot be rediscovered from inside the worktree itself — the worktree
is already checked out on `task-N` everywhere, so a fresh `bootstrapRepositoryManifest`
call from there would read `task-N` as if it were the source branch. Per
`plans/task-86-spec.md`'s "Bug found while grilling" section, "Each phase workflow
receives 'the pipeline args JSON exactly as printed' — a snapshot `prepareTasks`
froze before planning." `scripts/prepareTasks.ts`'s `runAsCli()` builds exactly this
JSON (`pipelineArguments`, containing `repositoryManifest: RepositoryManifest`,
built by `loadRepositoryManifest(repoRoot)` *before* any worktree is created, so its
`baseBranch` values are the real source branches) and both writes it to
`.taskTools/run-arguments.json` and prints it to stdout — and stdout is what a
launched workflow receives as `args`. So `ARGS.repositoryManifest` is the field this
stage reads; task.workflow.js itself never reads the run-arguments.json file (per the
same spec section), consistent with the existing code already only trusting `ARGS`
and `tasks.json`.

`ARGS.repositoryManifest.occurrences` always has at least the root entry (id `""`),
even with zero submodules, so no separate no-submodule special case is needed.

The stage passes this manifest into the already-built primitives —
`rebaseSubmoduleLayersDeepestFirst` (tasks 142/143) and `rebaseParentOntoSourceAndTest`
(task 144) — which internally call `discoverRepositoryTree(worktreePath, manifest)`
and refresh each occurrence's `checkoutPath` to the worktree while *reusing* the
already-resolved `baseBranch` (see `scripts/repositoryDiscovery.ts`'s
`discoverOccurrenceAndDescendants`: `if (existing && existing.baseBranch !== "")`
reuses it). This is why passing `ARGS.repositoryManifest` through unmodified works.

`rebaseGroupOntoSource` gains a 4th parameter (`leaveConflictLive`, default `false`,
so every existing caller keeps today's abort-first behavior with zero call-site
changes required at those sites). This new mode is threaded through
`rebaseAndTestSubmoduleLayer`, `rebaseSubmoduleLayersDeepestFirst`, and
`rebaseParentOntoSourceAndTest` (all in `scripts/mergeTaskWorktrees.ts`) so the
rebase-test stage can request it. `scripts/runMergePhase.ts`'s `MergeRetryDeps.
rebaseGroupOntoSource` type is `(worktreePath: string, sourceBranch: string) =>
RebaseOutcome` — a function with 2 extra optional parameters remains assignable to
that type in TypeScript, so `runMergePhase.ts` needs no edit (confirmed: `npx tsc
--noEmit` is clean both before and after, see Verification).

**Two occurrence-path sources, used for different things.** `ARGS.repositoryManifest`
(and everything derived from it inside `rebaseSubmoduleLayersDeepestFirst` /
`rebaseParentOntoSourceAndTest`) carries the *source* checkout's `checkoutPath` per
occurrence — that is what those primitives need to fetch each layer's `baseBranch`
from, and it is why they internally refresh `checkoutPath` to the worktree via
`discoverRepositoryTree` before touching git (see above). But the rebase-test stage
also needs the *task worktree's own* checkout path for every occurrence — to snapshot
HEAD before spawning the agent, to detect and commit edits the agent made in a
different layer, and to check those other layers are clean before continuing — and
`ARGS.repositoryManifest.occurrences[*].checkoutPath` is the wrong value for that (it
points at the source repo, not this task's worktree). So the stage separately builds
its own `occurrenceId -> task-worktree checkoutPath` map once, up front, by walking
`parentOccurrenceId` / `pathInParent` from the worktree root (`preparedTask.repoRoot`)
down: the root occurrence maps to `preparedTask.repoRoot` itself, and every other
occurrence maps to `join(<its parent's already-resolved worktree path>, its own
`pathInParent`)`. Every place that needs an occurrence's location in *this* task's
worktree — agent scope, HEAD/porcelain snapshots, fence-violation entries, and the
cross-layer commit step below — reads from this map, never from
`ARGS.repositoryManifest.occurrences[*].checkoutPath` directly.

Conflict handling loop, once a layer or the parent reports `status: "conflicted"`
with `leaveConflictLive: true` (rebase left in progress, real conflict markers in the
working tree): before spawning the agent, record `HEAD` for every *other* occurrence
(from the task-worktree map above). Spawn a merge-conflict agent scoped to the
conflicted occurrence's task-worktree `checkoutPath`, handed the exact
`conflictedFilePaths`. If it reports `resolved: false` (or returns nothing after
`retryAgent`'s own bounded retries), the stage runs `git rebase --abort` in that
checkout and returns the FAILURE CONTRACT outcome: `status: "blocked"`, `lastFailure:
"unresolved merge conflict"` — that exact string, always, regardless of whether the
abort itself also failed (an abort failure is carried in a separate `cleanupFailure`
field alongside it, so task 149 never has to parse extra text out of `lastFailure`).

If the agent reports `resolved: true`: any file changed in the conflicted occurrence's
own checkout that is not in `conflictedFilePaths` is a fence violation, staged anyway
(reported, never undone) so it rides along in the `--continue` commit. Then, for every
*other* occurrence, deepest-first (a child's cross-layer edit must be committed before
its parent, so the parent's own gitlink bump is visible when the parent's turn comes):
compute what changed there since the recorded `HEAD` plus anything still uncommitted;
every such path is a fence violation (recorded, not undone); if anything is
uncommitted, commit it on that occurrence's own `task-N` branch. If that occurrence is
still dirty afterward (the commit itself failed), abort the active rebase and return
the FAILURE CONTRACT outcome. Only once every other occurrence is confirmed clean does
the stage run `git rebase --continue` (with the editor disabled, so a plain
fast-forward continuation can never block on an interactive prompt) in the conflicted
checkout. A *new* conflict further down the same rebase is not a failure: the next
loop iteration's call to `rebaseSubmoduleLayersDeepestFirst` /
`rebaseParentOntoSourceAndTest` detects the still-in-progress rebase through
`rebaseGroupOntoSource`'s existing `rebaseInProgress` fallback path and reports it as a
fresh `"conflicted"` outcome — no separate resume logic is needed. A `--continue`
failure that is *not* a fresh conflict is a real failure: abort and return the FAILURE
CONTRACT outcome, with the underlying git error carried in `cleanupFailure`.

This loop has no round cap. A rebase replays a finite list of commits, so a loop that
only continues on progress (the agent resolving one conflict and `--continue`
succeeding or hitting the next real conflict) is already bounded by that commit count;
an artificial cap can only ever stop the walk *before* the rebase is done, leaving it
live and unfinished — which is why earlier drafts of this plan that capped the loop at
a fixed round count were wrong. The only per-attempt bound is `retryAgent`'s existing
3-attempt retry around a single conflict's agent call, unrelated to task 146's
`MAX_REBASE_FIX_ROUNDS`, which bounds a different loop (the red-layer fix loop) that
this task does not build.

A `stoppedAt` / outcome status other than `"conflicted"` (e.g. `"tests-failed"`,
`"cleanup-failed"`, `"untested"`, `"source-sync-failed"`) is returned as-is with
`status: "blocked"` and `lastFailure` set to that status string — no fix agent, no
retry. Building that retry is task 146's job (SCOPE BOUNDARY: "running any test suite
is task 146, which edits this same file and is chained behind this one"). The
individual layer/parent test execution itself is not new code written by this task —
it already happens inside `rebaseAndTestSubmoduleLayer` / `rebaseParentOntoSourceAndTest`
(built by tasks 142–144); this task only reacts to whatever those already-built
primitives report.

Fence violations ("Files edited outside the handed-over conflicted paths are
REPORTED, not blocked — same rule as the task 138 fence") are computed two ways,
matching the two places the agent is allowed to touch, both against the
task-worktree checkout-path map (never `ARGS.repositoryManifest`'s source paths),
and every entry is recorded as `{ occurrenceId, path }` — never a bare path string —
since two different occurrences can share the same relative path:
- In the occurrence that is mid-rebase (unstable `HEAD`, so commit-diffing doesn't
  work there): `git status --porcelain` after the agent finishes, minus the handed
  `conflictedFilePaths`.
- In every *other* occurrence (read scope is the whole tree; edit scope is any
  layer): `git rev-parse HEAD` recorded before the agent runs, `git diff --name-only
  <before>..HEAD` after, UNION the occurrence's still-uncommitted paths (the brief
  tells the agent to commit its own cross-layer edits, but the stage never trusts
  that self-report — it independently commits anything still uncommitted there, and
  fails the attempt if that occurrence is still dirty afterward). Any path found this
  way is unconditionally out of scope for this specific conflict hand-off, since
  `conflictedFilePaths` only ever describes the mid-rebase occurrence. Every path
  comes from `git`, not from agent self-report, matching how `runImplement`'s existing
  fence check works.

The merge-conflict agent brief folds in `merge.workflow.js`'s useful language: "keep
BOTH sides' intent" when resolving, and the forbidden list (no weakening/deleting/
stubbing code to make a conflict disappear, no force-push or hard-reset of anything
it didn't create). It drops `merge.workflow.js`'s `ARGS.approvedByUser` /
`ARGS.decisions` user-approval loop entirely — this stage is unattended and cannot
ask a human anything, and any conflict the agent can't clear becomes the FAILURE
CONTRACT outcome instead of a `decisions` entry. `merge.workflow.js` itself is not
edited or deleted by this task.

## Files — exact edit list or reason for no edit

### skills/tackle-tasks/task.workflow.js — edited (5 edits)

### scripts/mergeTaskWorktrees.ts — edited (5 edits)

### plans/task-86-spec.md — no edit (design/reference doc, read only; not
implementation)

### skills/tackle-tasks/merge.workflow.js — no edit. Its conflict-fixing language is
folded into the new `mergeConflictBrief` in task.workflow.js per the brief; the brief
explicitly forbids deleting or otherwise touching this file in this task ("DO NOT
DELETE merge.workflow.js in this task" — deletion is the end-of-chain task's job).

### scripts/repositoryDiscovery.ts — no edit. Read for `discoverRepositoryTree`'s
`checkoutPath`-refresh / `baseBranch`-reuse behavior, which the plan relies on but
does not change.

### scripts/repositoryManifest.ts — no edit. Read for the `RepositoryOccurrence` /
`RepositoryManifest` shapes the new code reads off `ARGS.repositoryManifest`; no
change to those types is needed.

### scripts/repositoryBranches.ts — no edit. `collectRepositorySources` is not called
by the new code (it reads the *current* branch of its argument, which would be wrong
called on a worktree already checked out on `task-N`; the plan uses
`ARGS.repositoryManifest`'s already-resolved `baseBranch` instead, exactly as
`rebaseSubmoduleLayersDeepestFirst` / `rebaseParentOntoSourceAndTest` already do
internally).

### scripts/resolutionRequests.ts — no edit. `createEmptyResolutionManifest` is
already exported (line 48) and is imported as-is by the new code.

### scripts/manifestBootstrap.ts — no edit. Read for how `bootstrapRepositoryManifest`
composes `discoverRepositoryTree`; not called by the new code (see repositoryBranches.ts
note above — the manifest instead comes from `ARGS.repositoryManifest`).

### scripts/prepareTasks.ts — no edit. Read to confirm `pipelineArguments` (its
`runAsCli()`, printed to stdout and read by every launched workflow as `args`)
already includes `repositoryManifest: manifest` — the field the new code reads. No
change needed to produce it.

### scripts/runMergePhase.ts — no edit. Read to confirm `MergeRetryDeps.
rebaseGroupOntoSource`'s 2-parameter type stays structurally assignable after
`rebaseGroupOntoSource` gains 2 more optional parameters (confirmed by running `npx
tsc --noEmit` against the edited tree in Verification — this file's own
`coordinateMergeRetry`/`resolveMergeVerdict`/etc. are the batch-retry machinery task
147 retires; SCOPE BOUNDARY: "the merge scheduling queue... is task 147", not this
task).

---

## scripts/mergeTaskWorktrees.ts — exact edits

### Edit M1 — export `uncommittedChangedFiles` (line 68)

Current text (line 68):
```
function uncommittedChangedFiles(worktreePath: string): string[] {
```

New text:
```
export function uncommittedChangedFiles(worktreePath: string): string[] {
```

Reason: `task.workflow.js`'s fence check for the mid-rebase occurrence reuses this
exact porcelain-parsing logic (already handles the "R  old -> new" rename case)
instead of duplicating it.

### Edit M2 — `rebaseGroupOntoSource` signature (lines 140–144)

Current text:
```
export function rebaseGroupOntoSource(
    worktreePath: string,
    sourceBranch: string,
    submodulePathsAllowedToConflict: string[] = [],
): RebaseOutcome {
```

New text:
```
export function rebaseGroupOntoSource(
    worktreePath: string,
    sourceBranch: string,
    submodulePathsAllowedToConflict: string[] = [],
    leaveConflictLive: boolean = false,
): RebaseOutcome {
```

### Edit M3 — live-conflict early return inside the conflict branch (lines 178–187)

Current text:
```
        if (!allConflictsAreAllowedSubmodules) {
            const abortResult = abortRebase(worktreePath);
            if (!abortResult.aborted) {
                return { status: "cleanup-failed", failureReason: combineFailureReasons(pendingReason, `abort also failed: ${abortResult.failureReason}`) };
            }

            if (conflictedFilePaths.length === 0) return { status: "cleanup-failed", failureReason: pendingReason };

            return { status: "conflicted", conflictedFilePaths };
        }
```

New text:
```
        if (!allConflictsAreAllowedSubmodules) {
            // Live mode hands the caller the still-in-progress rebase and real conflict markers, instead of aborting first.
            if (conflictedFilePaths.length > 0 && leaveConflictLive) {
                return { status: "conflicted", conflictedFilePaths };
            }

            const abortResult = abortRebase(worktreePath);
            if (!abortResult.aborted) {
                return { status: "cleanup-failed", failureReason: combineFailureReasons(pendingReason, `abort also failed: ${abortResult.failureReason}`) };
            }

            if (conflictedFilePaths.length === 0) return { status: "cleanup-failed", failureReason: pendingReason };

            return { status: "conflicted", conflictedFilePaths };
        }
```

### Edit M4 — thread the mode through `rebaseAndTestSubmoduleLayer` (lines 250–256 and line 276)

Current text (lines 250–256):
```
function rebaseAndTestSubmoduleLayer(
    occurrence: RepositoryOccurrence,
    sourceCheckoutPath: string,
    resolutionManifest: ResolutionManifest,
    childrenByParentId: Map<string, RepositoryOccurrence[]>,
): SubmoduleLayerOutcome {
    const { occurrenceId, checkoutPath, baseBranch, operationBranch } = occurrence;
```

New text:
```
function rebaseAndTestSubmoduleLayer(
    occurrence: RepositoryOccurrence,
    sourceCheckoutPath: string,
    resolutionManifest: ResolutionManifest,
    childrenByParentId: Map<string, RepositoryOccurrence[]>,
    leaveConflictLive: boolean = false,
): SubmoduleLayerOutcome {
    const { occurrenceId, checkoutPath, baseBranch, operationBranch } = occurrence;
```

Current text (line 276):
```
        const rebaseOutcome = rebaseGroupOntoSource(checkoutPath, baseBranch);
```

New text:
```
        const rebaseOutcome = rebaseGroupOntoSource(checkoutPath, baseBranch, [], leaveConflictLive);
```

### Edit M5 — thread the mode through `rebaseSubmoduleLayersDeepestFirst` (lines 313–317 and line 330)

Current text (lines 313–317):
```
export function rebaseSubmoduleLayersDeepestFirst(worktreePath: string, manifest: DiscoveryManifest): SubmoduleLayerWalkReport {
    const sourceCheckoutPathByOccurrenceId = new Map(
        manifest.repositoryManifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence.checkoutPath]),
    );
```

New text:
```
export function rebaseSubmoduleLayersDeepestFirst(worktreePath: string, manifest: DiscoveryManifest, leaveConflictLive: boolean = false): SubmoduleLayerWalkReport {
    const sourceCheckoutPathByOccurrenceId = new Map(
        manifest.repositoryManifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence.checkoutPath]),
    );
```

Current text (line 330):
```
        const outcome = rebaseAndTestSubmoduleLayer(occurrence, sourceCheckoutPath, manifest.resolutionManifest, childrenByParentId);
```

New text:
```
        const outcome = rebaseAndTestSubmoduleLayer(occurrence, sourceCheckoutPath, manifest.resolutionManifest, childrenByParentId, leaveConflictLive);
```

### Edit M6 — thread the mode through `rebaseParentOntoSourceAndTest` (lines 347–354)

Current text:
```
export function rebaseParentOntoSourceAndTest(
    occurrenceId: string,
    worktreePath: string,
    sourceBranch: string,
    submodulePaths: string[],
    resolutionManifest: ResolutionManifest,
): ParentRebaseOutcome {
    const rebaseOutcome = rebaseGroupOntoSource(worktreePath, sourceBranch, submodulePaths);
```

New text:
```
export function rebaseParentOntoSourceAndTest(
    occurrenceId: string,
    worktreePath: string,
    sourceBranch: string,
    submodulePaths: string[],
    resolutionManifest: ResolutionManifest,
    leaveConflictLive: boolean = false,
): ParentRebaseOutcome {
    const rebaseOutcome = rebaseGroupOntoSource(worktreePath, sourceBranch, submodulePaths, leaveConflictLive);
```

(Edits M2–M6 total 6 edit points across 5 named edits M2–M6, plus M1 — 7 edit points
in this file. Every other call site of `rebaseGroupOntoSource` /
`rebaseAndTestSubmoduleLayer` / `rebaseParentOntoSourceAndTest` /
`rebaseSubmoduleLayersDeepestFirst` in this same file — inside `mergeTaskDeepestFirst`,
lines 548 and 576 — is left untouched: both omit the new trailing argument, so both
keep today's default (`leaveConflictLive = false`, abort-first) behavior unchanged.)

---

## skills/tackle-tasks/task.workflow.js — exact edits

### Edit T1 — add `MERGE_CONFLICT_SCHEMA` (insert after line 63, before line 65)

Current text (lines 53–65, for anchoring — `WORKER_SCHEMA`'s closing brace and the
blank line before `fileRetryPreamble`):
```
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

const fileRetryPreamble = (missingFiles) => `Before planning: the workflow has already widened this task's owned files in tasks.json to include ${missingFiles.join(', ')} and regenerated the brief file — you do not need to run any command for this. The owned-files list below already includes the paths you previously flagged as missing.
```

New text (inserts `MERGE_CONFLICT_SCHEMA` between the two, everything else unchanged):
```
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

const MERGE_CONFLICT_SCHEMA = {
  type: 'object',
  properties: {
    resolved: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['resolved', 'summary'],
}

const fileRetryPreamble = (missingFiles) => `Before planning: the workflow has already widened this task's owned files in tasks.json to include ${missingFiles.join(', ')} and regenerated the brief file — you do not need to run any command for this. The owned-files list below already includes the paths you previously flagged as missing.
```

### Edit T2 — add `mergeConflictBrief` (insert after line 235, before line 237)

Current text (lines 233–238, for anchoring — the end of `workerBrief` and the start of
the `retryAgent` comment/definition):
```
You are forbidden to touch anything outside ownedFiles excluding notesFile; to
add scope or refactors the plan does not call for; to redecide anything the
plan already decided; to run the full suite, \`git add -A\`, or \`git add .\`; to
commit while anything fails; to attempt more than ${MAX_FIX_ROUNDS} fix
rounds; or to return status "done" with a failing test. Any test file created
or modified must be listed in ownedFiles; otherwise return status "blocked"
without editing it.`

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
```

New text (inserts `mergeConflictBrief` between the two, everything else unchanged):
```
You are forbidden to touch anything outside ownedFiles excluding notesFile; to
add scope or refactors the plan does not call for; to redecide anything the
plan already decided; to run the full suite, \`git add -A\`, or \`git add .\`; to
commit while anything fails; to attempt more than ${MAX_FIX_ROUNDS} fix
rounds; or to return status "done" with a failing test. Any test file created
or modified must be listed in ownedFiles; otherwise return status "blocked"
without editing it.`

const mergeConflictBrief = (checkoutPath, conflictedFilePaths) => `A rebase in ${checkoutPath} is stopped on live conflict markers, not aborted. Resolve exactly these conflicted paths — this is the complete list, do not search the repository for more:
${conflictedFilePaths.map((p) => `  - ${p}`).join('\n')}

Carry out every step below, in order, from top to bottom.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

You may READ anything, anywhere in the tree — callers, callees, tests, other layers.
You may EDIT any file in any layer — resolving a conflict often means updating a call
site, and a call site can live in a different repository.

for each path in the list above:
    open ${checkoutPath}/path
    resolve every <<<<<<< / ======= / >>>>>>> block, keeping BOTH sides' intent
    remove the conflict markers
    run(git -C ${checkoutPath} add path)

if resolving a conflict required editing a file in a DIFFERENT repository than ${checkoutPath}:
    run(git add) and run(git commit) for that edit, in that repository's own checkout, before moving on
    // a rebase requires a clean tree; an uncommitted edit in a not-yet-rebased layer would break that layer's own rebase

Do not run \`git rebase --continue\` or \`git rebase --abort\` in ${checkoutPath} yourself — the caller drives that after you return.

if git -C ${checkoutPath} diff --name-only --diff-filter=U prints nothing (every listed path is resolved and staged):
    return {resolved: true, summary: what you changed}
else:
    return {resolved: false, summary: what is still unresolved and why}

You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset anything you did not create; to run
\`git rebase --continue\` or \`git rebase --abort\` yourself; or to leave an edit
in a different repository uncommitted. Returning resolved false is a correct
outcome when a conflict genuinely cannot be resolved, not a failure.`

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
```

### Edit T4 — replace the `runRebaseTest` stub with the real implementation (lines 367–370)

(There is no Edit T3 in this revision — an earlier draft added a
`MAX_LIVE_CONFLICT_ROUNDS` constant here; it is not needed. See "This loop has no
round cap" in the design summary above.)

Current text (lines 367–370):
```
const runRebaseTest = () => {
  log(`task ${N}: rebase-test stage (stub)`)
  return { stage: 'rebase-test', task: N }
}
```

New text:
```
const readHeadOid = (execFileSync, checkoutPath) => execFileSync('git', ['-C', checkoutPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

const changedPathsSinceOid = (execFileSync, checkoutPath, beforeOid) => execFileSync('git', ['-C', checkoutPath, 'diff', '--name-only', `${beforeOid}..HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean)

// occurrenceId -> checkout path in THIS worktree, never the source manifest's checkoutPath.
const taskWorktreeCheckoutPaths = (occurrences, worktreePath, join) => {
  const byId = new Map(occurrences.map((o) => [o.occurrenceId, o]))
  const resolved = new Map()
  const resolve = (occurrenceId) => {
    if (resolved.has(occurrenceId)) return resolved.get(occurrenceId)
    const occurrence = byId.get(occurrenceId)
    const checkoutPath = occurrence.parentOccurrenceId === null
      ? worktreePath
      : join(resolve(occurrence.parentOccurrenceId), occurrence.pathInParent)
    resolved.set(occurrenceId, checkoutPath)
    return checkoutPath
  }
  for (const occurrence of occurrences) resolve(occurrence.occurrenceId)
  return resolved
}

const commitOccurrenceChanges = (execFileSync, checkoutPath, occurrenceId) => {
  try {
    execFileSync('git', ['-C', checkoutPath, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', checkoutPath, 'commit', '-q', '-m', `resolve merge conflict: cross-layer edit in ${occurrenceId === '' ? 'root' : occurrenceId}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const abortRebaseChecked = (execFileSync, checkoutPath) => {
  try {
    execFileSync('git', ['-C', checkoutPath, 'rebase', '--abort'], { stdio: 'ignore' })
    return { aborted: true, failureReason: null }
  } catch (error) {
    return { aborted: false, failureReason: String((error && error.message) || error) }
  }
}

// Editor disabled: a plain --continue must never block on an interactive prompt.
const continueRebaseChecked = (execFileSync, checkoutPath) => {
  try {
    execFileSync('git', ['-C', checkoutPath, 'rebase', '--continue'], { stdio: 'ignore', env: { ...process.env, GIT_EDITOR: 'true' } })
    return { continued: true, freshConflict: false, failureReason: null }
  } catch (error) {
    const stillConflicted = execFileSync('git', ['-C', checkoutPath, 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    // A later commit hit a fresh conflict: the next walk call reports it, not a failure.
    if (stillConflicted.length > 0) return { continued: false, freshConflict: true, failureReason: null }
    return { continued: false, freshConflict: false, failureReason: String((error && error.message) || error) }
  }
}

const runMergeConflictAgent = (checkoutPath, conflictedFilePaths) => retryAgent(() => agent(
  mergeConflictBrief(checkoutPath, conflictedFilePaths),
  { label: `rebase-conflict:${N}`, phase: `${N} Rebase-Test`, schema: MERGE_CONFLICT_SCHEMA },
))

// Resolves one conflict, commits cross-layer edits deepest-first, drives continue/abort.
const advanceLiveConflict = async (execFileSync, uncommittedChangedFiles, occurrencesDeepestFirst, checkoutPaths, activeOccurrenceId, conflictedFilePaths, fenceViolations) => {
  const checkoutPath = checkoutPaths.get(activeOccurrenceId)
  const otherOccurrences = occurrencesDeepestFirst.filter((o) => o.occurrenceId !== activeOccurrenceId)
  const beforeOids = otherOccurrences.map((o) => [o.occurrenceId, readHeadOid(execFileSync, checkoutPaths.get(o.occurrenceId))])

  const result = await runMergeConflictAgent(checkoutPath, conflictedFilePaths)
  if (result === null || result === undefined || result.resolved !== true) {
    const abortResult = abortRebaseChecked(execFileSync, checkoutPath)
    return { advanced: false, lastFailure: 'unresolved merge conflict', cleanupFailure: abortResult.aborted ? null : `abort failed: ${abortResult.failureReason}` }
  }

  for (const path of uncommittedChangedFiles(checkoutPath)) {
    if (!conflictedFilePaths.includes(path)) fenceViolations.push({ occurrenceId: activeOccurrenceId, path })
    execFileSync('git', ['-C', checkoutPath, 'add', path], { stdio: 'ignore' })
  }

  for (const [occurrenceId, beforeOid] of beforeOids) {
    const otherPath = checkoutPaths.get(occurrenceId)
    const uncommitted = uncommittedChangedFiles(otherPath)
    for (const path of new Set([...changedPathsSinceOid(execFileSync, otherPath, beforeOid), ...uncommitted])) {
      fenceViolations.push({ occurrenceId, path })
    }
    if (uncommitted.length === 0) continue
    const committed = commitOccurrenceChanges(execFileSync, otherPath, occurrenceId)
    if (!committed || uncommittedChangedFiles(otherPath).length > 0) {
      const abortResult = abortRebaseChecked(execFileSync, checkoutPath)
      const reason = `commit failed for occurrence "${occurrenceId}"`
      return { advanced: false, lastFailure: 'unresolved merge conflict', cleanupFailure: abortResult.aborted ? reason : `${reason}; abort failed: ${abortResult.failureReason}` }
    }
  }

  const continuation = continueRebaseChecked(execFileSync, checkoutPath)
  if (continuation.continued || continuation.freshConflict) return { advanced: true, lastFailure: null, cleanupFailure: null }
  const abortResult = abortRebaseChecked(execFileSync, checkoutPath)
  const reason = `continue failed: ${continuation.failureReason}`
  return { advanced: false, lastFailure: 'unresolved merge conflict', cleanupFailure: abortResult.aborted ? reason : `${reason}; abort failed: ${abortResult.failureReason}` }
}

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

Note on `lastFailure` for the two non-conflict "stopped" branches (the submodule-layer
one and the parent one): unlike the conflict path, these are not part of the FAILURE
CONTRACT's `"unresolved merge conflict"` string — they carry the primitive's own
status string (`"tests-failed"`, `"cleanup-failed"`, `"untested"`,
`"source-sync-failed"`) verbatim, per the design summary's "A `stoppedAt` / outcome
status other than `"conflicted"`... is returned as-is" rule above.

### Edit T5 — await the now-async `runRebaseTest` in `STAGE_RUNNERS` (line 380)

Current text (lines 377–387, for anchoring):
```
const STAGE_RUNNERS = {
  plan: async () => [await runPlan()],
  implement: async () => [await runImplement()],
  'rebase-test': () => [runRebaseTest()],
  merge: () => [runMerge()],
  'plan+implement': async () => {
    const planResult = await runPlan()
    if (planResult.status !== 'planned') return [planResult]
    return [planResult, await runImplement()]
  },
}
```

New text:
```
const STAGE_RUNNERS = {
  plan: async () => [await runPlan()],
  implement: async () => [await runImplement()],
  'rebase-test': async () => [await runRebaseTest()],
  merge: () => [runMerge()],
  'plan+implement': async () => {
    const planResult = await runPlan()
    if (planResult.status !== 'planned') return [planResult]
    return [planResult, await runImplement()]
  },
}
```

(`runRebaseTest` was synchronous before this task; `STAGE_RUNNERS['rebase-test']`
must now await it or the `results` array would hold an unresolved Promise instead of
the stage's returned object — `runMerge` stays synchronous and unawaited since this
task does not touch it, per SCOPE BOUNDARY.)

---

## Verification

Run every command from the repo root (`/Users/matkatmusicllc/Programming/taskTools-86`).

1. **Typecheck the whole tree** (baseline is already clean — confirmed by running this
   exact command against the unedited tree before writing this plan):
   ```
   npx tsc --noEmit
   ```
   Expect: no output, exit code 0. This proves `rebaseGroupOntoSource`'s two new
   optional parameters stay assignable to `scripts/runMergePhase.ts`'s
   `MergeRetryDeps.rebaseGroupOntoSource` type without editing that file, and that
   every threaded call site (M4/M5/M6) still typechecks.

2. **Run the existing test suite** (per project convention, `npm test`, not `bun
   test`):
   ```
   npm test
   ```
   Expect: the suite passes at least as many tests as before the edit, in particular
   every test listed by
   `grep -n "rebaseGroupOntoSource\|rebaseSubmoduleLayersDeepestFirst\|rebaseParentOntoSourceAndTest" tests/mergeTaskWorktrees.test.ts`
   (already confirmed to call these functions with 2–3 arguments only, so the new
   4th/6th parameter's default value is what runs — behavior is unchanged for every
   existing call site).

3. **Syntax-check the edited workflow file.** `task.workflow.js` is not a plain ES
   module or CommonJS script — it starts with `export const meta = {...}` (module-only
   syntax) and ends with a top-level `return` (function-only syntax), so it is loaded
   by a custom harness, not `node`/`import()` directly (confirmed: `node --check
   skills/tackle-tasks/task.workflow.js` fails on the top-level `return` even before
   any edit in this task). To still catch real syntax errors in the new code with a
   tool that is actually available, strip the leading `export ` from the `meta`
   declaration and wrap the remainder in an async function body, matching how the
   `args`/`agent`/`log` identifiers the file references are supplied at runtime:
   ```
   SCRATCH=/private/tmp/claude-501/-Users-matkatmusicllc-Programming-taskTools-86/03ce51a2-882e-4636-b400-c98b367e16c2/scratchpad
   { printf 'async function __wf(args, agent, log){\n'; sed 's/^export const meta/const meta/' skills/tackle-tasks/task.workflow.js; printf '\n}\n'; } > "$SCRATCH/wf-check.mjs"
   node --check "$SCRATCH/wf-check.mjs" && echo SYNTAX_OK
   ```
   Expect: `SYNTAX_OK` printed, exit code 0 (this exact recipe was run against the
   unedited file while writing this plan and printed `SYNTAX_OK`).

4. **Confirm the stub wording is gone and the new stage code is present:**
   ```
   grep -n "rebase-test stage (stub)" skills/tackle-tasks/task.workflow.js
   grep -n "leaveConflictLive" scripts/mergeTaskWorktrees.ts
   ```
   Expect: the first command prints nothing (exit code 1, no match); the second
   prints 6 matching lines (the signature and call-site edits in M2, M4, M5, M6).

5. **Temporary-repository verification of `leaveConflictLive`.** This exercises the
   exported `rebaseGroupOntoSource` primitive (M2/M3) directly — no submodule and no
   task.workflow.js harness needed, since it is a plain importable function. Everything
   below runs in a throwaway repo and is deleted afterward; it is not a permanent test
   file (the brief says "tests: skip", and no test path is in this task's owned files).

   Setup — run once, from the repo root:
   ```
   SCRATCH=/private/tmp/claude-501/-Users-matkatmusicllc-Programming-taskTools-86/03ce51a2-882e-4636-b400-c98b367e16c2/scratchpad
   rm -rf "$SCRATCH/t145-verify" && mkdir -p "$SCRATCH/t145-verify/repo" && cd "$SCRATCH/t145-verify/repo"
   git init -q && git config user.email t@t.co && git config user.name t
   echo base > f.txt && git add f.txt && git commit -qm base
   for i in 1 2 3 4; do echo "source-$i" > "f$i.txt" && git add "f$i.txt" && git commit -qm "source $i"; done
   git branch -f main
   git checkout -qb task-N HEAD~4
   for i in 1 2 3 4; do echo "task-$i" > "f$i.txt" && git add "f$i.txt" && git commit -qm "task $i"; done
   ```
   This makes 4 files that each conflict in turn when `task-N` is rebased onto `main`
   — enough to prove a longer rebase completes with no round cap.

   5a. **Live mode leaves real conflict markers and does not abort:**
   ```
   node -e "
   import('/Users/matkatmusicllc/Programming/taskTools-86/scripts/mergeTaskWorktrees.ts').then((m) => {
     console.log(JSON.stringify(m.rebaseGroupOntoSource('$SCRATCH/t145-verify/repo', 'main', [], true)))
   })"
   test -d "$SCRATCH/t145-verify/repo/.git/rebase-merge" && echo REBASE_LIVE
   grep -c '<<<<<<<' "$SCRATCH/t145-verify/repo/f1.txt"
   ```
   Expect: `{"status":"conflicted","conflictedFilePaths":["f1.txt"]}`, then `REBASE_LIVE`,
   then `1` (one real conflict-marker block left in the working tree, not aborted away).

   5b. **Resolving and continuing past 4 rounds proves no artificial cap is needed:**
   ```
   node -e "
   import('/Users/matkatmusicllc/Programming/taskTools-86/scripts/mergeTaskWorktrees.ts').then(async () => {
     const fs = await import('node:fs')
     const { execFileSync } = await import('node:child_process')
     const repo = '$SCRATCH/t145-verify/repo'
     let rounds = 0
     while (true) {
       const conflicted = execFileSync('git', ['-C', repo, 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).split('\n').filter(Boolean)
       if (conflicted.length === 0) break
       rounds += 1
       for (const p of conflicted) { fs.writeFileSync(repo + '/' + p, 'resolved-' + p + '\n'); execFileSync('git', ['-C', repo, 'add', p]) }
       try { execFileSync('git', ['-C', repo, 'rebase', '--continue'], { stdio: 'ignore', env: { ...process.env, GIT_EDITOR: 'true' } }) } catch {}
     }
     console.log(JSON.stringify({ rounds, commitsOntoMain: execFileSync('git', ['-C', repo, 'rev-list', '--count', 'main..task-N'], { encoding: 'utf8' }).trim() }))
   })"
   ```
   Expect: `{"rounds":4,"commitsOntoMain":"4"}` — 4 sequential conflicts, all resolved past
   round 3.

   5c. **Default (`leaveConflictLive` omitted) still aborts first and leaves a clean
   tree — unchanged behavior.** Rebuild the repo from the Setup block above, then:
   ```
   node -e "
   import('/Users/matkatmusicllc/Programming/taskTools-86/scripts/mergeTaskWorktrees.ts').then((m) => {
     console.log(JSON.stringify(m.rebaseGroupOntoSource('$SCRATCH/t145-verify/repo', 'main', [], false)))
   })"
   git -C "$SCRATCH/t145-verify/repo" status --porcelain
   test -d "$SCRATCH/t145-verify/repo/.git/rebase-merge" || echo NOT_LIVE
   rm -rf "$SCRATCH/t145-verify"
   ```
   Expect: `{"status":"conflicted","conflictedFilePaths":["f1.txt"]}`, then nothing from
   `status --porcelain` (clean tree), then `NOT_LIVE` (no rebase left in progress).

6. **Code-inspection checklist for the task.workflow.js-only orchestration** (cross-
   layer commit, fence-entry shape, non-active-occurrence cleanliness). These live
   inside `advanceLiveConflict`, which only runs through the full agent/log/ARGS
   harness — task.workflow.js is confirmed in step 3 above to not be independently
   `node`-runnable, and building a stand-in harness is out of scope given the brief's
   "tests: skip". Read the edited function in `skills/tackle-tasks/task.workflow.js`
   and confirm every line below holds; each is a literal string you can `grep` for:
   - every `fenceViolations.push(...)` call pushes an object `{ occurrenceId, path }`,
     never a bare path string — `grep -n "fenceViolations.push" skills/tackle-tasks/task.workflow.js`
     must show `{ occurrenceId:` (or the destructured `occurrenceId,`) on every line.
   - `checkoutPaths` (the `Map` built by `taskWorktreeCheckoutPaths`) is the only
     source read inside `advanceLiveConflict` for another occurrence's location —
     `grep -n "repositoryManifest.occurrences" skills/tackle-tasks/task.workflow.js`
     must show it used only inside `runRebaseTest` (to build `checkoutPaths` and
     `occurrencesDeepestFirst`), never inside `advanceLiveConflict`.
   - every non-active occurrence with an uncommitted change is committed via
     `commitOccurrenceChanges` before `git rebase --continue` runs — confirm the
     `for (const [occurrenceId, beforeOid] of beforeOids)` loop is written textually
     before the `continueRebaseChecked(...)` call.
   - `uncommittedChangedFiles(otherPath).length > 0` after `commitOccurrenceChanges`
     triggers an abort, not a silent continue — confirm the `if (!committed ||
     uncommittedChangedFiles(otherPath).length > 0)` branch returns `advanced: false`.
   - `lastFailure` is the literal string `'unresolved merge conflict'` on every
     `advanced: false` return in `advanceLiveConflict`, and any abort/commit/continue
     error is carried only in `cleanupFailure`, never appended to `lastFailure`.
