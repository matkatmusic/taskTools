# Phase 0–1 implementation audit

Audited against `plans/tackle-tasks-v1_5-plan.md` and
`plans/diagram/pipeline.mmd` on 2026-08-13. The audit covered the staged Phase 0 and Phase 1
implementation, its tests, and the existing helpers it calls.

## Verdict

Do not start Phase 2 from the current staged implementation. The focused tests and the full
suite pass, but the production behavior still has five release-blocking correctness defects.
Two smaller defects should be fixed in the same pass because they affect rollback and state
integrity and are cheap to cover now.

This document prescribes the implementation shape and regression tests needed to close the
audit. The fixes are intentionally specific so another design/review round is not needed.

## 1. P1 — submodule base refs come from the task worktree instead of the source manifest

### Evidence

`scripts/tackle-tasks/occurrences.ts::buildDiscoveryManifest` discards `projectRoot`, creates
an empty repository manifest, and discovers the task worktree. That is the wrong authority
for a layer's source branch.

`createWorktreeForGroup` checks out `task-N` in every submodule. Consequently:

- For an unchanged submodule, the recorded gitlink commit is often the tip of both the
  source branch and `task-N`. Discovery reports multiple candidates. Because `task-N` has
  no upstream, `getOccurrencesDeepestFirst` returns `baseRef: ""`.
- For a changed submodule, the parent task commit points at the new submodule task commit.
  Discovery can select `task-N` as the sole matching branch. A later
  `git diff task-N...HEAD` is empty, so test discovery, modified-file recording, and the
  file fence miss the submodule change.

This was reproduced with a real submodule and a worktree made by `createWorktreeForGroup`;
the child occurrence returned `baseRef: ""`. The existing test misses the bug because its
fixture manually checks the child out to `child-main` instead of using the production
preparer.

### Required fix

Build the `DiscoveryManifest` from the canonical source repository's resolved manifest,
then remap only its checkout paths into the task worktree:

```ts
export function buildDiscoveryManifest(
    worktreePath: string,
    projectRoot: string,
): DiscoveryManifest {
    const sourceManifest = loadRepositoryManifest(projectRoot);
    return {
        repositoryManifest: {
            ...sourceManifest,
            occurrences: sourceManifest.occurrences.map((occurrence) => ({
                ...occurrence,
                checkoutPath: occurrence.occurrenceId === ""
                    ? worktreePath
                    : join(worktreePath, occurrence.occurrenceId),
            })),
        },
        resolutionManifest: createEmptyResolutionManifest(),
    };
}
```

Import `loadRepositoryManifest` from `scripts/prepareTasks.ts` and `join` from
`node:path`. Do not run `discoverRepositoryTree` against the task worktree here. The source
manifest supplies each occurrence's resolved `baseBranch`; the path remap supplies the
checkout that later boxes must operate on.

`getOccurrencesDeepestFirst` should continue to override the root with the explicit
`rootSourceBranch`. For non-root occurrences, require a non-empty source-manifest
`baseBranch`. The upstream lookup may remain only as a compatibility fallback, but if both
are empty, throw an error naming the occurrence instead of returning an unusable empty ref.

### Required regression tests

Replace the hand-shaped occurrence fixture with the production path:

1. Build a source repository with a real submodule.
2. Create the linked worktree using `createWorktreeForGroup`, which creates `task-N` in both
   layers.
3. Prove an unchanged child has `baseRef === "child-main"`, never `""` or `"task-N"`.
4. Commit a change on the child's task branch and stage/commit its gitlink in the parent.
   Prove the child still has `baseRef === "child-main"` and that
   `git diff <baseRef>...HEAD` reports the child change.
5. Prove `buildDiscoveryManifest` preserves source `baseBranch`/`baseOid` values while every
   returned `checkoutPath` points inside the linked worktree.

## 2. P1 — acquisition publishes an incomplete source-lock file

### Evidence

`acquireSourceRepoLock` creates the final lock path with `openSync(..., "wx")` and only then
writes its JSON. A contender can observe `EEXIST` between those operations and call
`readSourceRepoLock`, which parses an empty or partial file. That throws `SyntaxError`
instead of returning `held` or `recoverable`.

Creating an empty lock file and calling `acquireSourceRepoLock` reproduces
`Unexpected end of JSON input`. The same state is reachable during a real concurrent
acquisition.

### Required fix

Use one short-lived mutation guard for every source-lock state transition, as described in
Finding 3. While holding that guard, acquisition must:

1. Read and classify the existing complete lock, if any.
2. Build the complete new `LockFile` in memory.
3. Write it to a unique same-directory temporary file, `fsync` and close it.
4. Atomically rename the temporary file to the final lock path.

Do not create the final path before its complete contents exist. Use a random suffix as well
as the PID for temporary names, and remove the temporary file on every failure path.

Because the mutation guard supplies exclusion, acquisition no longer needs `wx` on the
final durable-lock path. `readSourceRepoLock` outside the guard may observe the old file,
the new file, or no file, but never a partially written JSON document.

### Required regression tests

- Start multiple acquisition processes behind a barrier. Exactly one returns `acquired`;
  every other process returns `held` or `already-held-by-me`; none throws; the final file is
  valid JSON.
- Add a write-stage test seam and pause the winner before publication. A concurrent reader
  must see either no lock or the previous complete lock, never an empty/partial document.
- Inject a temporary-file write failure and prove no final lock and no temporary file are
  left behind.

## 3. P1 — refresh, release, and recovery are not one atomic ownership decision

### Evidence

Each operation reads the durable lock, validates the owner/heartbeat, and later renames or
unlinks the path without common exclusion. The `.recovery-guard` serializes only two
recovery calls; acquisition, refresh, and release ignore it.

Concrete unsafe interleavings include:

- Recovery validates owner A as cold; A refreshes; recovery then removes the newly warm
  lock.
- A refresh validates its ownership; recovery removes A; B acquires; A's rename overwrites
  B's lock and resurrects A.
- A release validates its ownership; another operation replaces A with B; A's unlink
  removes B's lock.

Any of these permits concurrent source-tail mutations or strands the wrong owner.

### Required fix

Add a dedicated callback-scoped `withSourceRepoLockMutationGuard(projectRoot, action)`.
This guard is not the durable source lock and does not span workflow boxes; it only makes a
single read/validate/write transition indivisible. It may use the same `wx`/wait/finally
pattern as `withTaskStateLock`, but it needs its own path under `.git` and must not share the
task-state lock.

Run all four mutators entirely inside it:

```text
acquire: guard -> read/classify -> atomically publish complete file -> release guard
refresh: guard -> read/verify exact owner -> atomically replace heartbeat -> release guard
release: guard -> read/verify exact owner -> unlink -> release guard
recover: guard -> re-read owner and heartbeat -> validate confirmation/coldness -> unlink
```

Remove the recovery-only guard once recovery uses the common mutation guard. A public
`readSourceRepoLock` remains a snapshot read; no mutator may make a decision from a snapshot
taken outside the common guard.

The guard is held by one short-lived process, so process liveness is meaningful for
diagnosing a stranded mutation guard even though it is not meaningful for the durable
cross-process source lock. On timeout, fail closed and report both the guard path and PID;
never delete a guard merely because time elapsed.

### Required regression tests

Use process barriers or a test-only callback after validation to force these exact orders:

- A paused refresh versus confirmed recovery: recovery waits, then re-reads the refreshed
  heartbeat and refuses it as warm.
- A paused release versus a replacement acquisition: acquisition cannot publish B until
  release completes; release never removes B.
- A paused refresh versus recovery plus acquisition: A can never overwrite B.
- Existing same-owner reacquisition and separate-process durability tests remain green.

## 4. P1 — the v1.1 archive launches the current workflow, not the archived workflow

### Evidence

The archived skill-body emitter launches a `workflowPath` returned by `prepareTasks`.
`prepareTasks` materializes that path exclusively from
`skills/tackle-tasks/tackle-tasks.workflow.js`. The archived
`skills/tackle-tasks-v1_1/tackle-tasks.workflow.js` is therefore not the file the archived
skill executes.

When Phase 10 rewrites the current workflow, invoking `tackle-tasks-v1_1` will execute that
new workflow with the old v1.1 prompt emitter. That defeats Phase 0's rollback purpose and
can produce an incompatible mixed-version run. The copied v1.1 test also reads the current
workflow, so it positively masks the coupling.

### Required fix

Keep the literal-meta materialization if the workflow harness requires it, but make the
template/version selection explicit and immutable:

1. Materialize two versioned files per prepared group:
   - current template -> `${worktree}.tackle-tasks.workflow.js`
   - archived template -> `${worktree}.tackle-tasks-v1_1.workflow.js`
2. Return both explicit fields, for example `workflowPath` and `v1_1WorkflowPath`.
3. The current skill-body emitter launches only `workflowPath`.
4. The archived skill-body emitter launches only `v1_1WorkflowPath`.
5. The materializer accepts an explicit template path; it must not contain a hidden default
   that always points to the current skill directory.
6. Teach the later Phase 6 cleanup to remove both sibling materialized files. Until Phase 6
   exists, Phase 1 tests must clean them explicitly.

This keeps the already-staged literal `meta` workaround while restoring a real frozen
rollback path. After this change, do not modify anything under `skills/tackle-tasks-v1_1/`
or `scripts/tackle-tasks-v1_1_*` in later phases.

Also fix the partial-preparation rollback while touching this code: register the newly
created worktree/lease for rollback before either materialization call, or wrap
materialization in a `try/catch` that releases that worktree's lease. In the current object
literal, `materializeTaskWorkflow(...)` runs before `preparedGroups.push(...)`, so a
materialization failure strands the lease.

### Required regression tests

- Assert the archived emitter names `v1_1WorkflowPath`, never `workflowPath`.
- Compile/run the archived workflow from the archived materialized file. The copied test
  must read `skills/tackle-tasks-v1_1/tackle-tasks.workflow.js`, not
  `skills/tackle-tasks/tackle-tasks.workflow.js`.
- Put distinct marker text in current and archived fixture templates and prove each emitter
  launches the matching marker.
- Change only the current template and prove the archived materialized bytes and archived
  emitted brief remain unchanged.
- Inject failure in the first and second materialization calls and prove every acquired
  worktree lease is released and no partial sibling workflow file remains.
- Retain the Phase 0 command check: the v1.1 emitted brief has zero references to
  `skills/tackle-tasks/` or `scripts/tackle-tasks_`.

## 5. P1 — worktree-lease adoption can create split-brain ownership

### Evidence

`adoptWorktreeLease` writes `tasks.json` with the new `leaseRunId` and then overwrites the
sibling lease file. If the lease write fails, the function throws after task state has
already committed, leaving the two authorities disagreeing. It also never reads the actual
sibling lease before overwriting it, so a stale `tasks.json` value can cause adoption to
steal a lease from a different on-disk owner.

### Required fix

Lease adoption must use both the task-state lock and a short-lived per-lease mutation guard
shared by `acquireTaskWorktreeLease`, `releaseTaskWorktreeLease`, and adoption.

Under both guards:

1. Re-read the task and validate that the active newest run is exactly `runId`.
2. Validate that `state.leaseRunId` names an ended prior run.
3. Read and parse the sibling lease. Require its `runId` to equal the old
   `state.leaseRunId`. Missing, malformed, or mismatched files refuse adoption without any
   write.
4. Write a small atomic adoption-intent journal next to the lease containing task number,
   worktree path, old lease bytes/owner, and new owner.
5. Atomically replace the lease with the new owner.
6. Atomically update `tasks.json` to the new `leaseRunId`.
7. Delete the intent journal.

On a caught failure, restore the exact old lease bytes before releasing the guards and leave
`tasks.json` unchanged; if restoration itself fails, throw an `AggregateError` that names
both failures and retain the journal.

At the start of acquire/release/adopt, reconcile a retained intent under the same two
guards. If the named new run is still the active claimant and the old run is ended, finish
the adoption; otherwise restore the old lease. This makes a process death between steps 5
and 6 recoverable instead of permanently splitting ownership.

Do not silently overwrite a lease whose on-disk owner differs from the expected stale
owner.

### Required regression tests

- On-disk owner mismatch refuses and changes neither file.
- Missing and malformed leases refuse and change neither file.
- Injected lease replacement failure leaves `tasks.json` on the old owner.
- Injected task-state write failure restores the exact old lease and retains no journal.
- Kill a child process after writing the intent, after replacing the lease, and after
  updating task state. The next lease operation reconciles each state to one consistent
  owner.
- The existing ended-owner adoption and live-owner refusal tests remain green.

## 6. P2 — the shared empty run state is mutable across tasks

### Evidence

`taskRunState.ts` returns one module-level `EMPTY_RUN_STATE` object for every task without a
`run` key. Its `history` array is mutable. A caller that mutates a returned empty state can
contaminate later reads and can cause a future claim to copy another task's synthetic
history into `tasks.json`.

### Required fix

Return a fresh value for legacy tasks:

```ts
function getRunState(task: TaskRecordWithRun): TaskRunState {
    return task.run ?? { active: false, worktree: null, leaseRunId: null, history: [] };
}
```

Alternatively freeze a template deeply and clone it on every return. The fresh literal is
simpler.

### Required regression test

Read a task with no `run`, mutate the returned `history`, then read both that task and a
second legacy task again. Both fresh reads must still have empty histories, and claiming one
must persist exactly one new record.

## 7. P2 — `replaceEndedRunOutcome` does not enforce its ended-run contract

### Evidence

The function overwrites the newest record and forces `active: false` without checking that
the run is already ended. A wrong call against an active run silently terminates it. The
only designed use is rule 10's failure after the success path has already ended a
`completed` run.

### Required fix

Before writing, require all of the following:

- `state.active === false`
- a newest record exists
- `newest.endedAt !== null`
- `newest.exitType === "completed"`

Otherwise throw without writing. Then overwrite `exitType`, `exitNote`, and `endedAt` in the
single existing locked write.

### Required regression tests

- Active run: throws and leaves bytes unchanged.
- Ended non-completed run: throws and leaves bytes unchanged.
- Ended completed run: converts to `run-failed`, remains inactive, and re-stamps `endedAt`.

## Plan/file-scope correction

The plan says Phase 1 edits only `scripts/prepareTasks.ts` and `.gitignore`, but the hashed
worktree convention also has an existing consumer in `scripts/mergeTaskWorktrees.ts`.
Leaving that consumer on the old basename-only directory would break recovery/listing.
The staged update to use `resolveTaskWorktreeConventionDirectory` is necessary and should
remain; amend the Phase 1 existing-files table to include `scripts/mergeTaskWorktrees.ts`.

The current skill-body emitter/workflow edits are justified only as part of the explicit
versioned materialization fix in Finding 4. They must not leave the v1.1 archive dependent
on a current template or current test fixture.

## Completion checklist

Phase 0–1 is ready only when all of these are true:

- [ ] Production-shaped occurrence tests prove source refs survive both unchanged and
      changed submodule task branches.
- [ ] Every source-lock mutation uses one common short-lived guard.
- [ ] The durable source-lock file is atomically published with complete JSON.
- [ ] Forced refresh/release/recovery interleavings cannot overwrite or delete a new owner.
- [ ] The v1.1 skill executes only a workflow materialized from the v1.1 template.
- [ ] Materialization failures release leases and remove partial workflow files.
- [ ] Lease adoption validates the on-disk owner and reconciles interrupted transactions.
- [ ] Legacy empty run states cannot leak mutations between calls or tasks.
- [ ] `replaceEndedRunOutcome` refuses active and non-completed runs.
- [ ] `node scripts/tackle-tasks-v1_1_SkillBodyEmitter.ts <<< '[1]'` emits a non-empty brief
      with zero hits for `skills/tackle-tasks/` and `scripts/tackle-tasks_`.
- [ ] `git diff --cached --check` passes.
- [ ] Focused Phase 0–1 tests pass.
- [ ] The full `npm test` suite passes using the repository's required test loop.

## Validation performed during this audit

- Focused Phase 0–1 selection: 78 tests passed.
- Full suite: 1,451 tests passed, 0 failed.
- `git diff --cached --check`: passed.
- Phase 0 emitted-brief path grep: zero forbidden current-pipeline path hits.

Those passing results do not cover the production submodule branch shape or the forced
cross-process interleavings above, which is why the defects escaped the current suite.
