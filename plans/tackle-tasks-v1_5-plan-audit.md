# tackle-tasks v1.5 plan audit — final pre-implementation check

Re-read the current `plans/tackle-tasks-v1_5-plan.md` against
`plans/diagram/pipeline.mmd`, with the diagram treated as the source of truth. The four
material gaps from the final check have now been resolved in the plan and, where they affect
global pipeline semantics, in the diagram. Cosmetic wording and speculative low-probability
cases remain intentionally out of scope.

## Verdict

The plan is ready for implementation with respect to every material issue identified by
this audit.

| Final issue | Status | Resolution |
|---|---|---|
| stale source-lock recovery | Resolved | Adds the explicit `recoverSourceRepoLock.ts` maintenance CLI; cold locks stop rather than loop, and recovery requires the exact owner plus typed operator confirmation. |
| incomplete lost-mutation reconciliation | Resolved | The policy now classifies state-writing test boxes as mutating, gives logical calls stable `stepId`s, and requires a reconciliation handler for every mutating workflow script. |
| archive-first partial close | Resolved | Close is complete only when the matching archive exists **and** the open record is absent; presence in both files reruns the idempotent close. |
| tracked generated documents | Resolved | `.gitignore` handles untracked artifacts while per-worktree `skip-worktree` flags isolate already tracked matches before generation and before commits. |

## Resolution scope check

All substantive changes in the current plan trace to a numbered audit item. I found no
unrelated intentional behavior change.

---

## Prior third-pass audit (historical)

## Previous eight blockers: status

| Previous blocker | Status | Resolution in the current plan |
|---|---|---|
| 1. No workflow could run `resolveTaskRun.ts` | Resolved | Phase 11 adds `resolve.workflow.js`, its schema, and SkillBodyEmitter path wiring. |
| 2. Source lock used the wrong primitive and shared a re-entrancy key | Partially resolved | `sourceRepoLock.ts` is now durable and its owner is `runId:taskNumber`; stale-lock recovery remains incomplete (finding 1 below). |
| 3. `run-failed` could not always use the exit chain | Partially resolved | Pre-claim/no-worktree/post-inactivation cases and claim outcomes are now specified; the success-tail claim race and post-archive lost-result case remain (findings 2 and 3). |
| 4. Rebase conflicts discarded the stopped layer | Resolved | Both rebase and advance return `stoppedAt {occurrenceId, checkoutPath}` and carry it through the loop. |
| 5. Occurrences lacked per-layer source refs and fence normalization | Resolved | `Occurrence.baseRef` and `buildOwnedOccurrencePaths` now provide one specified representation. |
| 6. Plan/review validators were unreachable | Resolved | The diagram and Phase 4 now contain `validatePlanFile.ts` and `validateCodexReview.ts` boxes. |
| 7. Cleanup left generated-doc changes and submodule persistence refs | Resolved in design | Generated docs are excluded from commits, and cleanup walks persistence refs in every source occurrence. The proposed exclude-file path itself is invalid in a linked worktree (finding 5). |
| 8. The close chain had no JSON-box implementation | Resolved | `buildClosureNote.ts` and `closeTaskRun.ts` replace the incompatible existing CLIs. One required closure-note input is still not recorded (finding 6). |

## Remaining blockers

### 1. The durable source lock has no executable stale-lock recovery

The API has only `acquire`, `release` and `read`. `AcquireOutcome` has no stale outcome, and
there is no recovery function, despite the prose saying an old dead-owner lock is
"recoverable, reported in the result, never silently stolen." `rebaseTaskWorktree` waits
when another owner holds the lock, so a lock left by a crashed workflow can make every
later task wait forever.

The proposed dead-process check is also incompatible with the lock design: acquisition and
release intentionally happen in different short-lived agent processes. The process that
created the lock exits while the workflow legitimately continues to hold it, so its PID
cannot prove the workflow is dead.

Define a real recovery protocol and API. It needs a durable indication of workflow
liveness or an explicit, fail-safe recovery action tied to the owning task/run—not the
acquisition process PID. Add a test that simulates a crashed owner and proves a later run
can recover without stealing a live workflow's lock.

### 2. The success path drops the task claim before cleanup and archive

The source diagram runs `mark task inactive` before CLEAN and ARCH. `claimTask` refuses
only when `run.active` is true. Therefore, while the first workflow is cleaning its
worktree and before `closeTaskRun` removes the open task, a second invocation can claim the
same task, observe/use the same recorded worktree, and race the first workflow deleting it
or archiving the task.

The source-repository lock does not prevent this: the second run reaches worktree handling
before it takes that lock.

Keep a non-claimable closing state until archive completes. For example, make `claimTask`
refuse an open task whose newest ended run has `exitType:"completed"`, or add an explicit
`closing` state. Test by pausing between OFFOK and CLEAN and attempting a second claim.

### 3. A lost `closeTaskRun` result cannot use the post-inactivation recovery path

Mutating agents are not retried because a null result may mean the mutation succeeded.
If `closeTaskRun` successfully moves the task to `completedTasks.json` but its agent result
is lost, Phase 8 classifies the null as `run-failed` and says to reopen the ended run in
`tasks.json`. The task is no longer there, so `writeTaskExitNotes({reopen:true})` cannot
update it. The same problem exists after a successful archive followed by any reporting
failure.

Make `closeTaskRun` recoverable by a durable receipt or by checking both task files after a
lost result. If the task is already archived with the expected run/commits, treat the close
as successful; if it is still open, run the specified reopen/exit logic. This distinction
must happen before reporting `run-failed`.

### 4. `runFullSuite.ts` violates the diagram's every-occurrence rule

Diagram rule 8 says every test-running box operates on every repository layer, deepest
submodule first and root last. `runTaskTests.ts` now does that, but Phase 5 still specifies
`runFullSuite.ts` as only `npm test` in the root worktree.

This is not covered by the earlier rebase test pass: a later `fix-suite` edit may change a
submodule, after which the FULL box tests only the root. The next merge helper may discover
the red submodule under merge-failure semantics instead of returning to the suite-fix loop.

Make FULL walk the same occurrences and run each layer's complete-suite policy deepest
first, aggregating output and failing if any layer is red. Add a test where root tests pass
and a submodule's full suite fails after a suite repair.

### 5. `worktree/.git/info/exclude` is not a valid path in a linked worktree

Phase 3 says `createTaskWorktree` writes generated-doc patterns to the worktree's
`.git/info/exclude`. In a linked worktree, `.git` is a file pointing at the real worktree
metadata directory, not a directory. This repository's current worktree confirms it:
`test -f .git` is true. Writing `.git/info/exclude` therefore fails on every normal NEW
path.

Resolve the exclude file with Git, e.g. `git -C <worktree> rev-parse --git-path
info/exclude`, and document that this is normally the common repository exclude file. Test
using a real `git worktree add`, not a standalone repository fixture.

### 6. `buildClosureNote.ts` requires verification data that is never recorded

The specified closure note includes `Task tests: 4 files, green` and `Full suite: green`,
and Phase 7 says it reads those values from the finished run record after the worktree has
been deleted. `TaskRunRecord` contains no task-test file list/count or suite result, and no
state-writing box records either value.

Either add verification fields to the run record and scripts that store TT/FULL results
before cleanup, or remove those fields from the deterministic closure-note format. As
written, VNOTES cannot produce its required output from its stated inputs.

### 7. The HASH box has no script

The source diagram contains `record merge commit hashes to tasks.json` between merge and
completion. The plan says `appendTaskCommits` exists and `mergeTaskWorktree.ts` returns
merge commits, but no green-box script calls that library function. Phase 6's table jumps
from `mergeTaskWorktree.ts` to cleanup, Phase 7 has no HASH wrapper, and the file map has no
`recordMergeCommits.ts`.

The import-free workflow cannot call `appendTaskCommits` itself. Without a script, the
archived run loses all merge commits and `closeTaskRun` cannot pass the intended merge
hashes. Add the HASH script and its stdin/JSON schema, put it in the file map/policy map,
and test append-not-overwrite behavior.

### 8. Unknown outcomes of mutating scripts are not generally recoverable

The plan correctly refuses to blindly retry a mutating script after a null agent result,
but then immediately enters `run-failed`. A null result means the mutation may already have
succeeded. This is unsafe for more than `closeTaskRun`:

- lost `applyPlanAmendments` result may leave the plan amended, but the run exits instead of
  implementing it;
- lost `commitTaskWork` result may leave committed work whose hashes were appended—or a
  commit whose state append failed;
- lost `mergeTaskWorktree` result may mean the merge landed; treating it as ordinary
  failure can later retry or misreport it;
- lost CLEAN/OFF/EXIT results can make the recovery chain operate on already-transitioned
  state.

"Do not retry" prevents double mutation but does not resolve the unknown outcome. Every
mutating step needs an idempotency receipt or a read-only reconciliation check that decides
whether it completed before selecting the next edge. The existing merge persistence refs
can support merge reconciliation; plan revision/artifact state can support amendment
reconciliation. Add a fault-injection test for lost results after at least amendment,
commit, merge, cleanup, and archive.

## Minor inconsistencies

### 9. The file count is wrong

The file map says 33 new script files, but its group counts total 40:
`4 + 5 + 10 + 4 + 2 + 6 + 6 + 1 + 2 = 40`. The new resolver workflow is additional.
This will mislead task assignment and policy-directory completeness tests. Recount from the
explicit list and use that number.

### 10. Phase 1 says "three libraries" but defines four

Phase 1's heading says three libraries; the plan and file map define
`taskRunState.ts`, `occurrences.ts`, `sourceRepoLock.ts`, and `writeTaskBrief.ts`.

### 11. The plan still says every old audit finding is resolved

The introduction says every numbered audit finding is resolved and cited as `[audit N]`,
but this audit now intentionally contains unresolved findings and uses multiple generations
of labels (`[audit N]`, `[audit-2 N]`, and one malformed `[audit, merge hashes]`). Replace
that promise with a dated/audit-version reference or remove it once revisions land.

### 12. Reopening an ended run is assigned to the wrong abstraction

The plan says `writeTaskExitNotes({reopen:true})` clears `endedAt`, writes the failure, and
"re-ends" the run. That bundles lifecycle transitions into a box otherwise defined as only
writing exit notes and conflicts with the claim that `taskRunState.ts` is the only module
that manages `task.run`. Define a single library operation such as
`replaceEndedRunOutcome` and have the CLI call it under one task-state lock. Avoid exposing
an intermediate active/reopened state across multiple writes.

### 13. The plan scrap loop does not say how Codex notes reach the replanner

The diagram edge explicitly says `replan with codex notes`, but
`validateCodexReview.ts` returns only `{valid, problem, verdict}` and the `plan` role's
return/payload contract contains no scrap-note field. The notes exist in
`codex-review.json`, but the plan never instructs the second planner invocation to read that
file. Specify that input explicitly or return the validated notes/path from VALR.

### 14. `root-merged-but-not-closed` carries incomplete commit data

The mapping reports `merged:true` with `failureReason`, but the helper status carries a
root `mergedCommitHash` separately from `completedLayers`. The plan's generic successful
mapping says commits come from `completedLayers`, which can omit the root merge in this
status. Define that HASH includes `mergedCommitHash` as the root merge commit and dedupes it
against any completed entries.

### 15. Worktree creation initializes submodules twice

`createWorktreeForGroup` already calls `initializeSubmodulesInWorktree`; the diagram then
runs `initTaskSubmodules.ts` after NEW/GEN/AMD. This is harmless and idempotent, but it means
the INIT box is not the sole implementation of its diagram action and failures can happen
earlier under NEW semantics. Either extract initialization out of the new single-task
creation path or explicitly accept that NEW includes INIT and document the duplicate.

## Speculative edge cases worth deciding before implementation

### 16. The generated-doc ignore mechanism is shared across all linked worktrees

After fixing the path with `git rev-parse --git-path info/exclude`, the result is normally
the common repository's `info/exclude`, not a per-worktree file. Concurrent task creation
will edit the same file outside the task-state/source locks. The plan also never removes
the patterns, so entries accumulate, and identical `plans/plan.json` patterns affect every
worktree.

Prefer per-worktree index flags only if they work for untracked files, a repository-owned
`.gitignore` rule committed as infrastructure, or an atomic/locked common-exclude updater
with deliberate permanent patterns. At minimum test two concurrent worktree creations.

### 17. The worktree lease ownership model conflicts with resumed runs

Worktree paths are stable per task. A previous failed run intentionally leaves its
worktree and lease for inspection/resumption. A new invocation has a new `runId`, but the
Q1/QS/QRS resumed path never transfers the old lease to the new run. Later CLEAN and REL
release with the new `runId`, which `releaseTaskWorktreeLease` rejects because the old run
owns the lease.

Define an atomic lease-adoption operation allowed only after the task claim succeeds and
the old run is ended, preserving retained work. Do not use `recoverStaleTaskWorktreeLease`:
that helper refuses when the worktree contains the very retained work being resumed.

### 18. Worktree paths and branches collide across separate clones with the same basename

`createWorktreeForGroup` currently derives `/tmp/taskTools-wt/<basename>/task-N` and branch
`task-N`. Two different repositories named the same thing, or two concurrent checkouts of
one repository, can collide in the temp path. This repository already has multiple
`taskTools` worktrees. Consider including a stable hash of the absolute project root and
the invocation/task owner in the path while keeping the task branch convention explicit.

### 19. Fixed source-lock timeout can expire during a legitimate long merge tail

The default stale threshold is two hours, but the lock is held across conflict agents,
test-fix loops, full suites, merge, cleanup and archive preparation. A live difficult task
can exceed it. Time alone must not authorize takeover; use a renewable heartbeat or an
explicit operator recovery after checking task/run state.

### 20. FULL needs a defined policy for repositories with no discovered suite

Once FULL becomes occurrence-aware, `discoverTestPolicy` can return `needsResolution`.
The rebase helper maps this to operational `run-failed`, but Phase 5 does not state whether
FULL does the same, skips the layer, or falls back to a conventional command. Use the same
policy/status rule across both boxes.

### 21. Test selection treats every changed existing test as task-created

`runTaskTests` selects tests added **or changed** since the base, while the prose repeatedly
calls them tests "this task created." That distinction controls whether `amend-tests` may
edit them. Preserve Git status (`A` versus `M`) in discovery so the prompt can distinguish
created tests from modified foreign tests and apply the exception deliberately.

### 22. The ownership-widening path is referenced but not in this pipeline

The fence section says a legitimately needed external test is added to `task.files` first
"by the same widening path v1 used," but v1.5 defines no box, script, or user gate that can
do this during a run. Decide whether such a need always exits `fence-violation` for a later
task-file update, or add an explicit approved widening transition. Do not leave the agent
to mutate `tasks.json` outside the diagram.

### 23. Cleanup order can strand the worktree after releasing its lease

CLEAN releases the worktree lease before removing the worktree/branches. If removal then
fails, the task retains work but no ownership marker; another process can attempt to take
it. Delete persistence and remove branches/worktree first while ownership is held, then
release the lease last (and source lock after all cleanup), or specify why the existing
order is safe.

### 24. Source-lock waiting needs a bounded/reporting behavior

`rebaseTaskWorktree` says it waits when the lock is held but gives no polling interval,
timeout, cancellation, or user-visible status. A workflow agent/tool call may time out
before the owner releases. Prefer returning a `held` verdict and letting the workflow retry
the read-only acquisition check, or specify bounded waiting and how it differs from
`run-failed`.

### 25. Empty or malformed task-number input is unspecified

`resolveTaskRun` parses the argument string, but the plan does not state the result for no
numbers, duplicates, non-integers, zero/negative values, or repeated task numbers. Normalize
and dedupe while preserving order; reject empty/malformed input before launching workflows.

### 26. Partial cleanup followed by `run-failed` can erase useful modified-file evidence

The post-inactivation recovery chain reruns `recordTaskModifiedFiles`. If CLEAN already
deleted the worktree before failing on a later cleanup operation, this returns `[]` and can
overwrite the successful path's previously recorded modified files. Specify merge/keep
semantics: a missing worktree must leave an existing non-empty record unchanged rather than
replace it with empty.

### 27. Closure-note commit ordering is internally inconsistent

`TaskRunRecord.commits` is documented as work/repair commits followed by merge commits, but
Phase 7 says `closeTasks` receives "merge entries first." Decide whether the archive stores
all commits in chronological/run order or only merge commits. The close-task API calls the
field `commitHashes`, and downstream readers may assume it identifies published commits.

### 28. `closeTasks` archive-first two-file writing remains crash-partial

`closeTasks` intentionally writes `completedTasks.json` before `tasks.json`, making a crash
leave the task in both files and a retry possible. That is existing behavior, but the new
claim path prefers the open record, so another invocation during that partial state can
claim an already-archived task. Consider making QV/Q0 treat presence in both files as a
recoverable close-in-progress state rather than ordinary open.

### 29. Source branch movement outside this pipeline is only serialized cooperatively

The new lock protects concurrent v1.5 tasks, but ordinary user Git operations or other
skills do not honor it. A source checkout can move or become dirty while the lock is held.
Re-read and verify the source branch/checkout state immediately before merge, and refuse to
overwrite unrelated dirty changes. Existing merge helpers checkout the source branch and
may interact with user state.

### 30. The run-history array has no growth or archival policy for repeatedly failing tasks

This is not a near-term blocker, but every attempt retains notes, file lists and all commit
hashes in `tasks.json`, and every fresh brief appends every previous ended run. A heavily
retried task can produce a large task file and prompt. Consider a bounded brief history
while retaining the full structured history, or an archive threshold.

## Resolution order

1. Preserve the claim through the success tail and make archive result-loss recoverable.
2. Finish the source-lock recovery protocol.
3. Make FULL occurrence-aware.
4. Correct the linked-worktree exclude path.
5. Add the missing HASH operation and lost-mutation reconciliation.
6. Align the closure-note format with recorded state.
7. Resolve lease adoption and cleanup ordering before relying on resume behavior.
