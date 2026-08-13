# tackle-tasks v1.5 — Phase 2–7 implementation audit

Audited the staged Phase 2–7 snapshot signaled by `.done` against:

- `plans/tackle-tasks-v1_5-plan.md`
- `plans/diagram/pipeline.mmd` (the authority when it differs from the plan)
- `plans/plan-format.md`
- the Phase 1 libraries consumed by these scripts

The review covered the staged scripts and tests, their calls into the existing Git/worktree
helpers, failure ordering across boxes, and the run/lease/source-lock state that crosses process
boundaries. This audit intentionally includes consequential minor inconsistencies and plausible
edge cases. It excludes naming/style preferences and other nits that do not change behavior,
recovery, or evidence quality.

## Verdict

**Do not build Phase 8 on this snapshot yet.** The ordinary single-repository happy path is
substantially implemented, all plan-listed test names exist, and the follow-up suite is green,
but several failure and concurrency paths violate the diagram's global rules. Most importantly:

1. a source submodule that advances after worktree creation cannot be reliably rebased;
2. a workflow can continue mutating after it has lost the durable source lock;
3. cleanup can report success to the process while retaining the worktree, lease, and lock;
4. a lease-ownership mismatch is ignored immediately before destructive reset; and
5. late processes are not fenced by `runId` when they mutate the current task run.

The changes below are designed as one coherent fix set. Applying only the local-looking changes
would leave the cross-process failure modes intact.

## Priority summary

| ID | Priority | Area | Required before Phase 8 |
|---|---|---|---|
| F1 | P1 | submodule rebase source/worktree identity | yes |
| F2 | P1 | source-lock ownership and heartbeat continuity | yes |
| F3 | P1 | merge-time source-tip verification | yes |
| F4 | P1 | reset after lease-owner mismatch | yes |
| F5 | P1 | cleanup failure semantics and retained ownership | yes |
| F6 | P1 | `runId` fencing for state mutations and archive | yes |
| F7 | P2 | resumability containment and lease establishment | yes |
| F8 | P2 | renamed/deleted task-test discovery | yes |
| F9 | P2 | recursive submodule safety check | yes |
| F10 | P2 | blanket gitlink fence exemption | yes |
| F11 | P2 | worktree creation failure between Git and state recording | yes |
| F12 | P2 | partial-close retry inputs and archive preconditions | yes |
| F13 | P2 | amendments can write an invalid plan | yes |
| M1–M4 | Minor | path, parser, cleanup-input, fixture inconsistencies | with the related fix |

---

## Material findings and resolving changes

### F1 — P1: submodule rebase conflates source and worktree checkout paths

**Evidence**

`rebaseTaskWorktree.ts` calls `buildDiscoveryManifest(worktreePath, projectRoot)` and passes the
result to `rebaseSubmoduleLayersDeepestFirst`. `buildDiscoveryManifest` first loads the source
manifest, then overwrites every occurrence's `checkoutPath` with the task-worktree checkout.
The rebase helper snapshots `manifest.repositoryManifest.occurrences[*].checkoutPath` as its
`sourceCheckoutPathByOccurrenceId` map before discovering the worktree. Consequently, the
supposed source path and the worktree path are identical.

This is not only an architectural wart. A real reproduction with a root repository, a real
submodule, and a real linked task worktree failed as follows after the source submodule and root
gitlink advanced after worktree creation:

```text
fatal: not a tree object
... git -C <task-worktree>/child ls-tree -r <new-source-submodule-oid>
```

The new source object was not present in the worktree submodule yet, and discovery attempted to
read it before any fetch from the real source checkout. If the object happens to be present, the
later fetch is from the checkout to itself, so the task can instead rebase onto a stale local
base branch without failing. The staged rebase test changes only the task submodule; it never
advances the source submodule and therefore cannot detect either outcome.

**Required fix**

Do not overload one `checkoutPath` field with two meanings. Introduce an occurrence view that
retains both paths, for example:

```ts
type WorktreeOccurrence = {
    occurrenceId: string;
    sourceCheckoutPath: string;
    worktreeCheckoutPath: string;
    // existing branch/parent/depth fields
};
```

Build it by matching source-manifest occurrences to a worktree discovery by `occurrenceId`.
Then change the rebase helper (or add a v1.5-specific wrapper/helper) so:

1. discovery and Git changes run in `worktreeCheckoutPath`;
2. base-branch fetches come from `sourceCheckoutPath`;
3. source OIDs are read after the source lock is acquired;
4. discovery never tries to inspect a source-only OID in the worktree before fetching it; and
5. the same mapping is reused by advance, fence, tests, merge, modified-file recording, and
   cleanup rather than reconstructed with different path semantics.

Do not fix this by fetching from `origin`. The locked local source checkout is the target branch
authority, and its commits may not have been pushed.

**Regression tests**

- Create the task worktree, then independently commit in the source submodule and update the
  source root gitlink. Add a divergent task-submodule commit. Rebase and assert the new source
  submodule commit is an ancestor of the rebased task-submodule `HEAD`.
- Repeat with conflicting edits and assert `stoppedAt` names the submodule and reports paths
  relative to that submodule.
- Use a source-submodule commit that is not present in the task clone or its remote; this pins
  the required local-source fetch.
- Exercise a nested submodule so the source/worktree mapping is proven at more than one depth.

### F2 — P1: tail scripts do not prove they still own the source lock

**Evidence**

`advanceTaskRebase`, `checkTaskFileFence`, `mergeTaskWorktree`, and `cleanupTaskWorktree` call
`refreshSourceRepoLock` but discard `{refreshed:false}`. A false result means the durable lock is
missing or belongs to another owner. Each script nevertheless continues; merge and cleanup then
mutate source repositories. `recordMergeCommits` does not refresh the heartbeat at all, despite
the Phase 6 requirement that every script from rebase onward do so.

This permits the exact race explicit recovery is meant to prevent: run A becomes cold, an
operator confirms recovery, run B acquires the lock, and a delayed process from run A resumes.
Run A's refresh is refused, but the current code still advances/rebases/merges/cleans alongside
run B.

The contention result has a second defect: `acquireSourceRepoLockBounded` returns
`heldByOwner`, but `rebaseTaskWorktree` discards it and returns `failureReason:null` for both
`held` and `recoverable`. The workflow therefore cannot log the holding owner or print the exact
confirmed-recovery command required by diagram rule 9.

**Required fix**

Add one library guard and use it consistently:

```ts
function refreshOwnedSourceRepoLockOrThrow(projectRoot: string, owner: string): void {
    const { refreshed } = refreshSourceRepoLock(projectRoot, owner);
    if (!refreshed) throw new Error(`source repository lock is no longer owned by "${owner}"`);
}
```

- Use the guard before any work in advance, fence, merge, record-merge-commits, and cleanup.
- Add `runId` to `recordMergeCommits` input so it can build the exact owner token.
- For scripts shared by the success tail and the pre-lock exit chain, distinguish the two call
  sites explicitly. The success-tail call must require and refresh the lock; an exit that never
  acquired it must not manufacture one. A `requireSourceLock` input is acceptable if only the
  workflow sets it and tests cover both modes; separate exported functions are harder to misuse.
- Return `heldByOwner` in `RebaseTaskWorktreeOutput`. For `recoverable`, also return the exact
  command, constructed by the same exported formatter used by `recoverSourceRepoLock.ts`, so
  command text cannot drift.
- If cleanup is already fully complete, an idempotent reconciliation may return success without
  a lock. It must first prove that the worktree, task branches, persistence refs, and owned lease
  are all absent. A missing lock alone is not proof of completion.

**Regression tests**

- For every tail script, seed a lock owned by another run and assert no Git/task mutation occurs.
- Acquire for run A, recover/reassign to run B, then invoke a delayed run-A merge and cleanup;
  both must fail before mutation.
- Assert `recordMergeCommits` refreshes the correct `runId:taskNumber` owner.
- Assert held and recoverable outputs contain the owner; recoverable output must exactly match
  the maintenance CLI's required confirmation command.

### F3 — P1: merge does not verify that source tips are where rebase left them

**Evidence**

The plan requires merge to confirm immediately beforehand that the source branch is where rebase
left it and that the source checkout is clean. `mergeTaskWorktree` verifies only the currently
checked-out root branch name and `git status --porcelain`. A user can make and commit a new clean
source change while the durable lock is held. The branch name is unchanged and the checkout is
clean, so merge proceeds even though the task was never rebased or tested against that tip.

The same issue applies independently to each source submodule branch.

**Required fix**

- After lock acquisition, have the rebase box capture the exact `{occurrenceId, baseBranch,
  sourceTip}` for root and every source occurrence.
- Persist that map in the current run record (best for lost-result reconciliation), or return it
  and carry it durably to merge. Do not rely only on an in-memory workflow value.
- Immediately before merge, while proving lock ownership, compare `rev-parse <baseBranch>` in
  every source occurrence with its recorded tip and verify every source checkout is structurally
  usable and clean.
- Any mismatch is an operational `run-failed`, as the plan specifies. Do not silently rebase in
  the merge box because that bypasses the full-suite and fence gates.

**Regression tests**

- After a successful rebase, commit an unrelated clean root change and assert merge refuses.
- Repeat with a committed source-submodule change plus updated root gitlink.
- Preserve the existing dirty-check test; clean movement and dirty movement are different cases.

### F4 — P1: reset ignores lease-owner refusal and then deletes the worktree

**Evidence**

When adoption returns false, `resetTaskWorktree` catches every error from
`releaseTaskWorktreeLease` and continues to `removeWorktreeAndBranch`. The release helper is
already idempotent for a missing lease. Its meaningful throw is an owner mismatch. Swallowing
that error removes a worktree that the durable lease explicitly says belongs to another run.

**Required fix**

- Remove the catch. Missing leases already return normally; an owner mismatch must abort reset
  before persistence or worktree removal.
- Better, replace the adopt-or-release sequence with one Phase 1 library operation performed
  under the task-state lock and lease guard. It should return one of:
  `adopted`, `released`, `absent`, or `refused-owner-mismatch`.
- Do not mutate persistence, branches, or the worktree for the refused outcome.
- Re-read state inside the locked operation rather than using the initial unlocked snapshot for
  destructive decisions.

**Regression tests**

- Put owner B in the sibling lease while task state names owner A; reset as A and assert the
  worktree, branch, persistence refs, and B's lease are byte-for-byte unchanged.
- Keep the twice-idempotent test for an absent/already-released lease.

### F5 — P1: cleanup converts removal failure into a successful process result

**Evidence**

`cleanupTaskWorktree` catches every `removeTaskWorktreeAndBranches` error and returns
`{removed:false, retainedArtifacts}` with exit status zero. The diagram has no `removed?`
diamond: CLEAN flows directly to closure-note construction and archive. Unless future workflow
code adds an undocumented special case, a retained worktree can be archived as completed while
its lease and source lock remain held. The original error is also discarded, so even a workflow
that notices `removed:false` cannot write a useful `run-failed` note.

There is a related ownership conflict. Phase 6 correctly keeps the lease when removal fails, but
global rule 10 then sends the cleanup error through the exit chain, whose `releaseTaskRunHolds`
currently releases that lease. This defeats the stated reason for releasing ownership last:
retained work is again left without its marker.

**Required fix**

- Treat removal failure as operational failure. Collect retained artifacts, then throw an error
  containing the original cause and the artifact list so the CLI exits nonzero and rule 10 runs.
- On the post-inactivation cleanup-failure recovery path, release the source lock but retain the
  worktree lease while the worktree or retained task branch still exists. Add an explicit
  `preserveWorktreeLease` recovery input or derive the decision with an ownership-checked retained
  artifact query.
- On ordinary exits that intentionally retain a resumable worktree, choose one coherent lease
  policy and encode it in both plan and code. The safest fit with `adoptWorktreeLease` is: retain
  the ended run's lease while its worktree remains, always release the source lock, and let the
  next claimed run atomically adopt the lease. If the intended policy is instead to release it,
  the next run must atomically reacquire an absent lease before reporting resumable.
- Never continue to closure/archive until cleanup reconciliation proves all intended removals and
  releases completed.

**Regression tests**

- Force worktree removal failure; the CLI must exit nonzero, stderr must contain the original
  failure and retained artifacts, the task outcome must become `run-failed`, and the worktree
  lease must remain.
- Assert the source lock is released on the finalized failure path so unrelated tasks can run.
- Resume the failed task and prove the new run adopts the retained lease before touching work.
- Prove a successful idempotent cleanup still works after a lost stdout result.

### F6 — P1: task-state mutations are not fenced by the run's identity

**Evidence**

`runId` is defined as the run's identity, but most state-mutating APIs select "the newest active
run" using only `taskNumber`. Examples include `updateCurrentTaskRun`, `appendTaskCommits`,
`endTaskRun`, task/full-suite result recording, exit-note recording, modified-file recording,
and mark-inactive. Their CLIs generally do not accept `runId`.

This becomes corrupting under diagram rule 11. A process may time out after mutation began; the
workflow reconciles, ends the run, and a later invocation claims the task. If the old process
then finishes, it writes into the later run because that is now the newest active record. A
delayed close call is worse: `closeTaskRun` can archive whatever open record currently has the
task number without verifying that it is the ended, completed run that requested closure.

`stepId` distinguishes logical test visits but does not bind a result to a run.

**Required fix**

- Make `expectedRunId` mandatory on every mutation of `task.run`.
- Under the same `withTaskStateLock` window used for the write, verify that the newest active
  record has exactly that run ID. On mismatch, throw before writing.
- Require the same identity for `endTaskRun` and `replaceEndedRunOutcome`; the latter must replace
  the specified ended run, not whichever run is newest at call time.
- Add `runId` to every affected stdin schema: create/record notes, commit append, task tests,
  full suite, merge-commit recording, exit notes, modified files, mark inactive, closure-note
  build, and close/archive.
- Make archive eligibility part of the same task-state lock as close: the specified run must be
  newest, inactive, `endedAt !== null`, and `exitType === "completed"`. Extend `closeTasks` with a
  checked close request or add a locked single-task close primitive; do not perform an unlocked
  precheck followed by the current `closeTasks` call.

**Regression tests**

- Pause an old task-test or commit-recording process, end its run, claim a new run, then release
  the old process. Assert the new run is unchanged and the old call fails.
- Attempt mark-inactive and exit-note writes with a sibling run ID.
- Attempt archive with a stale run ID and with an active/not-completed run; both must leave both
  task files unchanged.

### F7 — P2: resumability accepts an external notes file and does not require lease ownership

**Evidence**

`isTaskRunResumable` treats any existing absolute `implementationNotesFile` as proof of
resumability. A reproduction using a notes file outside the worktree returned:

```text
{ resumable: true, implementationNotesFile: <outside path>, leaseAdopted: true }
```

This contradicts the Phase 3 requirement that the file exist **in the worktree**. The function
also returns `resumable:true` when lease adoption returns false, allowing work to continue with
no proven ownership. That is common if the prior exit released the physical lease but left
`task.run.leaseRunId` and the worktree recorded.

**Required fix**

- Resolve both the worktree and notes file with `realpathSync`, then require the notes path to be
  a regular file below `${realWorktree}${sep}`. This handles absolute paths, `..`, and symlinks.
- Atomically establish ownership before returning resumable: adopt an ended owner's matching
  lease, or acquire an absent lease for the current claimed run under the lease guard and update
  `leaseRunId` in the same journaled transition.
- A mismatched live owner is not resumable. A failed adoption/acquisition must return
  `resumable:false` (or throw operationally); it must never return true with
  `leaseAdopted:false`.
- Rename the output to `leaseEstablished` if it can mean adoption or fresh acquisition.

**Regression tests**

- Absolute outside file, `../` escape, and symlink escape all return not resumable without
  touching the lease.
- An absent lease is acquired for the current run, state is updated, and resumability is true.
- A different physical owner is preserved and resumability is false.

### F8 — P2: task-test diff parsing mishandles rename and deletion statuses

**Evidence**

`runTaskTests` splits every `git diff --name-status` record into exactly
`[status, relativePath]`. A rename/copy record has three fields: status, old path, and new path.
The code selects the removed old path and invokes `node --test` on a path that no longer exists.
If Git represents the change as delete-plus-add, it attempts to run the deleted path and can
also misclassify the renamed destination as a task-created test.

**Required fix**

- Parse `git diff --name-status -z` so whitespace and rename fields are unambiguous.
- Normalize each change to `{kind, oldPath?, newPath?, runnablePath?}`.
- For `A` and `M`, run the current path; only exact `A` belongs in `createdTestFiles`.
- For `R`/`C`, run the destination path but do not call it created unless the policy explicitly
  decides copies are new tests. The safest reading of diagram rule 3 is that renamed/copied
  pre-existing tests are not created by this task.
- Do not pass `D` paths to Node. Record deleted tests separately (add `deletedTestFiles`) and
  make deletion an explicit red/flagged decision rather than an accidental file-not-found error.
  If the schema cannot grow, return a clear red result naming the deletion.

**Regression tests**

- Rename an existing test and assert the destination runs and is absent from
  `createdTestFiles`.
- Delete an existing test and assert deterministic policy output, not Node's missing-file error.
- Include a test filename containing spaces to pin the `-z` parser.

### F9 — P2: worktree safety checks only direct submodules

**Evidence**

`checkTaskWorktreeSafe` runs `git submodule status` without `--recursive`. A populated direct
child with an uninitialized grandchild is therefore reported safe. The staged tests contain no
submodule fixture at all, so they do not exercise the requirement that every submodule be
populated.

**Required fix**

- Run `git submodule status --recursive` and treat every `-` entry as unpopulated.
- Treat command failure as `safe:false` with a useful problem rather than an uncaught exception,
  because this box is a structural verdict.
- Keep `+` as populated unless the plan deliberately expands "safe" to mean exact recorded
  gitlink; dirty/different commits alone are not currently unsafe.

**Regression tests**

- Use a real root → child → grandchild fixture and deinitialize only the grandchild.
- Assert the returned problem uses its root-relative occurrence path.

### F10 — P2: every gitlink path is exempted from the ownership fence

**Evidence**

`checkTaskFileFence` builds `structuralGitlinkPaths` for every submodule occurrence and always
removes those paths from violations. A task can therefore move an unowned submodule gitlink to
an arbitrary commit without changing any owned file inside that submodule and still pass the
fence. The plan authorizes computed mechanical gitlink bumps, not an unconditional widening of
the task's ownership boundary.

**Required fix**

Exempt a parent gitlink only when all of the following are proven from Git state:

1. the child occurrence contains at least one task change;
2. every non-structural child change is itself inside the owned occurrence paths;
3. the parent's `HEAD:<gitlink>` equals the child checkout's `HEAD`; and
4. the gitlink is a direct parent/child relation in the discovered occurrence graph.

Otherwise report the parent gitlink as a fence violation. Compute this deepest-first so nested
gitlinks are justified by their children rather than blanket-exempted.

**Regression tests**

- Legitimate owned submodule edit plus mechanical parent gitlink remains inside the fence.
- A parent gitlink moved to an arbitrary commit with no child change is a violation.
- An unowned child edit plus its gitlink reports the child path and does not become legal through
  the structural exemption.

### F11 — P2: worktree creation can strand an unrecorded lease and worktree

**Evidence**

`createTaskWorktree` creates the Git worktree and acquires its lease before recording
`task.run.worktree`/`leaseRunId`. If `updateCurrentTaskRun` fails, the exit chain reads no
worktree from task state and cannot release the newly acquired lease. The conventional path is
then occupied by an unrecorded retained worktree, and later `doesTaskWorktreeExist` continues to
answer false because it only trusts task state.

**Required fix**

- Journal the create intent before Git mutation, including task number, run ID, conventional
  path, and branch; or add an ownership-checked rollback around the state-recording step.
- On state-write failure after a newly created worktree, remove only the worktree/branch created
  by this exact operation and release only its lease. Aggregate rollback errors with the original
  error.
- Phase 8 reconciliation must inspect both the journal/conventional path and sibling lease. It
  must be able to finish recording a completed creation or safely roll back an incomplete one.
- Never infer ownership from the conventional path alone.

**Regression tests**

- Inject failure into the task-state write after `git worktree add`; assert no unrecorded
  worktree, task branch, lease, or journal remains after successful rollback.
- Inject rollback failure and assert the durable journal contains enough exact ownership data for
  operator/reconciliation recovery.

### F12 — P2: close retries trust caller-supplied archive data and lack checked preconditions

**Evidence**

`closeTaskRun` forwards caller-supplied `closureNote` and `commitHashes`, defaulting hashes to an
empty array. On an archive-first partial retry (task in both files), a different/recomputed input
overwrites the durable archive entry. The plan explicitly requires the already stored archived
note and hashes to be passed back on that retry. The current test covers only a first successful
close.

The wrapper also does not derive the required chronological commit list from the recorded run and
does not enforce the run-completed preconditions described in F6.

**Required fix**

- Make close input `{taskNumber, runId, projectRoot, closureNote}`; derive commit hashes from the
  specified recorded run in chronological order. Reject caller-supplied commit arrays.
- Under the close lock, if the task is in both files, verify the archived record belongs to the
  same run and reuse its stored `closureNote` and `commitHashes` exactly. Complete only the open
  record removal/unblocking portion.
- If only open, require the specified newest run to be inactive and completed, then archive the
  deterministic note and recorded hashes.
- If only completed, return reconciled success only when run identity, note, and hashes match;
  otherwise report ambiguity rather than overwrite.

**Regression tests**

- Simulate failure after the completed-file write, retry with deliberately different note/hashes,
  and assert the original archive bytes are preserved while the open task is removed.
- Retry after complete success and assert reconciled success without rewrite.
- Reject active, non-completed, and stale-run close requests.

### F13 — P2: a valid amendment file can produce an invalid plan

**Evidence**

Plan validation requires a non-empty section list and kebab-case unique IDs. Review validation
only checks that amendment IDs are non-empty strings. Amendment application can therefore insert
`Not_Kebab` or remove every section and then write the invalid result. There is no second
validation box between amendment application and implementation.

**Required fix**

- Apply `SECTION_ID_PATTERN` to inserted IDs during review/amendment validation.
- Simulate both the live ID set and live section count in amendment order; reject a batch whose
  final count is zero.
- Construct the candidate plan in memory, call the same complete plan-shape validator on it, and
  write only if that validation succeeds.
- Use an atomic file replacement for the amended plan so a killed process cannot leave truncated
  JSON for reconciliation.

**Regression tests**

- Reject a non-kebab inserted ID.
- Reject removing the sole section and removing all sections across a batch.
- Inject a write failure and assert the original plan remains valid and byte-identical.

---

## Minor inconsistencies and speculative edge cases worth fixing

These are not style nits. Each can select the wrong task/path or make a destructive/recovery
operation ambiguous.

### M1 — Artifact CLIs accept `projectRoot` but still depend on process cwd

`validatePlanFile`, `validateCodexReview`, and `applyPlanAmendments` carry `projectRoot` but read
`planFilePath`/`reviewFilePath` exactly as supplied. Relative paths therefore violate global rule
8's no-cwd-dependence requirement. Several other CLIs also trust that `projectRoot` and worktree
paths are absolute without checking.

**Fix:** create shared input validators that require an absolute `projectRoot`; require absolute
artifact/worktree paths where the contract says they are absolute. Where relative paths are
deliberate (implementation notes), resolve them against the explicitly supplied worktree and
perform the realpath containment check from F7. Add CLI tests launched from an unrelated cwd.

### M2 — Task-number parsing accepts unsafe integers and unmatched bracket syntax

`parseTaskNumberArgument` accepts values beyond `Number.MAX_SAFE_INTEGER`, which can round two
different task tokens to the same number before deduplication. It also strips a leading `[` or a
trailing `]` independently, accepting malformed inputs such as `[1` and `1]`.

**Fix:** after lexical integer validation, require `Number.isSafeInteger(number) && number > 0`.
If bracket syntax is supported, require balanced outer brackets and reject inner bracket tokens;
otherwise remove bracket stripping and accept only the documented delimiter form. Test the two
unsafe adjacent integers and unmatched brackets.

### M3 — Cleanup accepts a caller-selected destructive branch name

Other scripts derive `task-<N>`, but cleanup accepts `branchName` independently from
`taskNumber`. A malformed workflow payload can delete persistence refs/branches for the wrong
task.

**Fix:** remove `branchName` from stdin and derive it with `taskBranchName(taskNumber)` inside the
script. If compatibility temporarily requires the field, reject any value that does not exactly
match the derived branch before mutation.

### M4 — Two staged Git test suites violate the required layered fixture rule

`resolveTaskRun.test.ts` uses a standalone repository, and `checkTaskWorktreeSafe.test.ts` uses a
linked worktree but no submodule. This is material because the missing layered fixture concealed
F9, and the plan explicitly requires every Git-touching test to use a real submodule and real
`git worktree add`.

**Fix:** move the shared real root/submodule/worktree builder into test support. For the resolver's
"creates no worktree" behavior, create a control linked worktree first, snapshot
`git worktree list --porcelain` and the convention directory, invoke the resolver, and assert no
additional worktree/lease/branch appeared. Use the nested fixture required by F9 for worktree
safety.

---

## Coordinated implementation order

The following order avoids fixing one layer against an API that a later fix must replace:

1. **Occurrence identity:** introduce distinct source/worktree paths and migrate rebase,
   advance, tests, fence, merge, modified-file recording, and cleanup to the shared mapping.
2. **Run and source-lock guards:** add `expectedRunId` checks to task-state mutations and
   `refreshOwnedSourceRepoLockOrThrow` to the locked tail; extend schemas once.
3. **Rebase receipt:** persist per-occurrence source tips under the expected run ID.
4. **Merge and fence:** verify the receipt at merge and replace blanket gitlink exemptions with
   proven mechanical propagation.
5. **Lease lifecycle:** make reset/adopt/acquire/release transitions atomic and settle the
   retained-worktree lease policy.
6. **Create/cleanup/close failure semantics:** add creation journaling/rollback, make cleanup
   failures nonzero while preserving retained ownership, and make close checked/idempotent from
   durable state.
7. **Validation/test discovery:** fix rename/delete parsing, recursive submodule safety, final
   amended-plan validation, and absolute-path validation.
8. **Tests:** add the regression matrix below, then run the prescribed full-suite loop until a
   clean initial pass is obtained.

## Acceptance matrix

The Phase 2–7 correction is complete only when all of these are true:

- [ ] A task submodule rebases onto a local, unpushed source-submodule advance.
- [ ] Root and nested-submodule conflicts return the correct stopped occurrence and paths.
- [ ] Every source-mutating tail call proves the exact lock owner immediately before mutation.
- [ ] Held/recoverable lock output includes the owner and exact recovery command.
- [ ] A clean committed source-tip movement after rebase blocks merge.
- [ ] Reset cannot alter a worktree or lease owned by another run.
- [ ] Cleanup failure exits nonzero, preserves retained work ownership, and cannot reach archive.
- [ ] A late process cannot write tests, commits, exit state, inactive state, or archive data into
      a newer run.
- [ ] Resumability requires contained notes and established lease ownership.
- [ ] Renamed tests run at the destination; deleted tests have an explicit deterministic result.
- [ ] Nested uninitialized submodules make worktree safety false.
- [ ] Only mechanically justified gitlink changes are exempt from the file fence.
- [ ] Failure between worktree creation and task-state recording leaves a reconcilable receipt or
      a complete rollback.
- [ ] Archive-first retry preserves the original archived note/hashes byte-for-byte.
- [ ] Amendment application can never write a plan that the plan validator rejects.
- [ ] CLI behavior is independent of cwd and task numbers remain safe integers.
- [ ] Every Git-touching Phase 2–7 test uses the required real layered linked-worktree fixture.

## Verification observed during this audit

- `git diff --cached --check`: clean.
- All 68 test names explicitly listed for Phases 2–7 are present.
- `npx tsc --noEmit`: passed.
- Prescribed follow-up full suite: 1,601 passed, 0 failed.
- Focused `sourceRepoLock` suite: 17 passed, 0 failed.
- The first full-suite pass failed two Phase 1 source-lock concurrency tests; both passed on the
  immediate full rerun and focused rerun. This appears timing-sensitive rather than a deterministic
  staged regression, but one green run should not be treated as evidence for the untested races
  above.

No implementation or staged files were changed by this audit.
