# Task 29 Plan: Run-scoped recovery refs after each worker and each synchronization

## Note on how this plan was produced

This plan was written from `plans/brief-29.md` only, per the orchestrator's
instruction to not read other files during planning. Two consequences for
whoever implements this:

1. **First implementation step, before any other code**: read
   `scripts/repositoryIntegration.ts` in full. This plan assumes it already
   exports a function that performs "recursive gitlink substitution" — find
   its real name/signature and reuse it as-is (ponytail rung 2: don't
   reimplement what already exists a few files over). Do not guess at the
   signature below; the names used here (`substituteGitlinksRecursively`,
   etc.) are placeholders for "whatever repositoryIntegration.ts actually
   calls it."
2. Also read `tests/relatedTests.test.ts` (or another recent test file in
   `tests/`) before writing `tests/recoveryRefs.test.ts`, to match this repo's
   actual test-runner import style (`bun:test` vs something else) and
   assertion style. This plan assumes `bun:test`.

If step 1 reveals no such function exists yet in repositoryIntegration.ts,
stop and flag it — this plan is written on the premise that it does (per the
brief: "via scripts/repositoryIntegration.ts"), and building that logic from
scratch inside recoveryRefs.ts would be a different, larger task.

## Behavior, in plain English

At two moments during a run — right after a worker finishes its unit of
work, and right after an N-way synchronization of multiple
workers/occurrences — the system takes a snapshot of the full, current,
recursive repository state (including any nested occurrence repos linked in
via gitlinks, and including whatever is currently uncommitted in the working
tree) and records that snapshot under a ref namespaced to the current run.
This exists so that if the run is killed, nothing done since the last
worker/sync checkpoint is lost — the recovery ref can be inspected or
restored from later.

This must happen **without**:
- moving the operation branch or the base branch (no checkout, no reset, no
  commit onto whatever branch is currently checked out)
- disturbing the working tree or index a worker is actively using (a worker
  may still be mid-edit; the snapshot must not stage/unstage/touch its real
  `.git/index` or its files)

And it must be safe to call more than once for the same checkpoint (must not
error, must not corrupt the ref, must not leave stray temp state behind).

## Why a temporary index

`git write-tree` only ever reads from an index, not from the working tree
directly. To capture uncommitted changes without touching the real index,
build a throwaway index (via the `GIT_INDEX_FILE` env var pointing at a temp
file), populate it from the current working tree with `git add -A` run under
that env override, `git write-tree` from it, then discard the temp file. The
real index and working tree are never opened for writing.

## Ref naming scheme

```
refs/recovery/<runId>/worker/<snapshotId>
refs/recovery/<runId>/sync/<snapshotId>
```

- `runId`: identifies the current tackle-tasks run (caller-supplied string;
  this module does not invent run IDs, it just namespaces refs under
  whatever ID the caller passes — check whether an existing run-id concept
  already exists elsewhere in the codebase before adding a new one, per
  ponytail rung 2).
- `snapshotId`: caller-supplied identifier for *this* checkpoint (e.g. a
  worker name, or a worker name + task id, or a sync round number). This
  module does not auto-increment a sequence — YAGNI unless the brief's tests
  demand ordered history, which they don't (they only require that *a*
  recovery ref exists and resolves correctly after each checkpoint, and that
  repeats are idempotent). If the caller reuses a `snapshotId`, the ref is
  simply updated to the new commit; that is the idempotent case.
- No new branch is ever created — only refs under `refs/recovery/...`, which
  `git branch`/`git checkout` will not surface, satisfying "without moving
  any operation or base branch."

## Public API to implement (`scripts/recoveryRefs.ts`)

Keep this file under 250 lines. If it grows past that, split the temp-index
plumbing (build/populate/write-tree/cleanup) into a second small file
(e.g. `scripts/temporaryIndex.ts`) before it happens, not after — check line
count as you go.

```ts
function recoveryRefName(runId: string, kind: "worker" | "sync", snapshotId: string): string
```
Pure string builder for the ref path above. No git calls. Write this first,
it needs no fixture and is the first RED/GREEN pair.

```ts
function snapshotWorkerRecovery(repoPath: string, runId: string, snapshotId: string): Promise<string>
function snapshotSyncRecovery(repoPath: string, runId: string, snapshotId: string): Promise<string>
```
Both return the commit SHA the ref now points to. Both do the same work,
differing only in `kind` passed to `recoveryRefName` — implement one shared
internal function (e.g. `writeRecoverySnapshot(repoPath, runId, kind,
snapshotId)`) and have both public functions call it. Do not duplicate the
temp-index/gitlink-substitution/commit-tree/update-ref sequence twice.

Internal sequence for `writeRecoverySnapshot`:
1. Create a temp file path for the throwaway index (e.g. under the repo's
   `.git` dir or `os.tmpdir()` — prefer the repo's own `.git` dir so it's on
   the same filesystem as the real index, consistent with how git itself
   stages temp indexes).
2. Run `git add -A` in `repoPath` with `GIT_INDEX_FILE` set to that temp
   path, and `GIT_DIR`/cwd set to `repoPath`, so it reads the real working
   tree but writes only to the temp index.
3. Run `git write-tree` with the same `GIT_INDEX_FILE` override to get a raw
   tree SHA reflecting current working-tree content (including dirty
   changes), for `repoPath` only — not yet recursive into nested occurrences.
4. Delete the temp index file (in a `finally`, so a thrown step 2/3 error
   still cleans up).
5. Pass that raw tree SHA (and `repoPath`) into repositoryIntegration.ts's
   recursive-gitlink-substitution function (real name TBD — see note at top
   of this plan) to get back a tree SHA where every nested-occurrence gitlink
   entry has been replaced with a freshly-snapshotted recursive tree for that
   nested occurrence's own current state (including *its* uncommitted
   changes — this recursion is why the brief says "via
   scripts/repositoryIntegration.ts" rather than asking recoveryRefs.ts to
   walk gitlinks itself).
6. `git commit-tree <substitutedTreeSha> -m "recovery: <kind> <snapshotId> (<runId>)"`
   with no parent (a recovery ref does not need ancestry history to do its
   job — it just needs to resolve to a tree with the right state; adding
   parent-chaining would be scope the brief didn't ask for).
7. `git update-ref refs/recovery/<runId>/<kind>/<snapshotId> <commitSha>` in
   `repoPath`.
8. Return the commit SHA.

Nothing in this sequence touches `HEAD`, `refs/heads/*`, or the real index —
that is what makes it safe to run while a worker is mid-edit and what keeps
the operation/base branch unmoved.

## Order of implementation (strict red-green TDD, per `~/.claude/guides/tdd.md`)

Write each test as RED first (plain-English steps as comments, `assert
false`/`expect(...).toBe(...)` against not-yet-existing code), then write
the minimum code to go GREEN, in this order:

1. `test_recoveryRefName_buildsWorkerRefPath` /
   `test_recoveryRefName_buildsSyncRefPath` — pure string tests, no git
   fixture needed. Implement `recoveryRefName`.
2. `test_snapshotWorkerRecovery_createsResolvableRef` — Scenario: after
   calling `snapshotWorkerRecovery` in a fresh test repo with a committed
   file, `refs/recovery/<runId>/worker/<snapshotId>` exists and `git
   cat-file -p <ref>^{tree}` contains that file. Implement the internal
   sequence steps 1–4 and 6–7 first with a no-op passthrough for step 5
   (skip gitlink substitution temporarily is not acceptable per TDD — instead
   sequence this test using a repo with zero nested occurrences, so step 5
   is exercised but has nothing to substitute; do not stub it out).
3. `test_snapshotSyncRecovery_createsResolvableRef` — same shape as #2 for
   the sync kind, confirming `snapshotSyncRecovery` shares the same internal
   function (assert both refs can coexist for the same `runId` without
   colliding).
4. `test_snapshotRecovery_capturesUncommittedWorkerChanges` — Scenario:
   modify a tracked file and add a new untracked file in the repo *without*
   committing, call `snapshotWorkerRecovery`, then read the tree at the
   resulting ref and assert both the modified content and the new untracked
   file are present. This is the step-2/step-3 behavior (temp index sees
   working-tree state) under direct test.
5. `test_snapshotRecovery_leavesRealIndexAndWorkingTreeUntouched` — Scenario:
   capture `git status --porcelain` output before calling
   `snapshotWorkerRecovery`, call it, capture `git status --porcelain`
   again, assert the two are identical. Proves the temp-index approach
   doesn't leak into the real index/working tree.
6. `test_snapshotRecovery_leavesOperationAndBaseBranchesUnmoved` — Scenario:
   record the SHA that `refs/heads/<baseBranch>` and
   `refs/heads/<operationBranch>` point to before, call
   `snapshotWorkerRecovery` (and separately `snapshotSyncRecovery`), assert
   both branch refs still point to the same SHA after. Use whatever
   base/operation branch naming convention already exists in this codebase
   (check `scripts/occurrenceBranchNames.ts` or similar before inventing
   branch names for the test fixture).
7. `test_snapshotRecovery_isIdempotentOnRepeatedCalls` — Scenario: call
   `snapshotWorkerRecovery` twice in a row with the same `runId`/`snapshotId`
   and no state change in between; assert no error is thrown on the second
   call, and that the tree SHA the ref resolves to is identical both times
   (commit SHAs may legitimately differ due to timestamps — assert on
   `<ref>^{tree}`, not on the commit SHA itself). Also assert no leftover
   temp index files remain in the repo's `.git` dir after either call.
8. `test_snapshotRecovery_reachesNestedOccurrenceContentThroughGitlink` —
   Scenario: build a fixture repo with a nested occurrence directory that is
   itself a git repo linked in as a gitlink entry (mode `160000`), with
   uncommitted changes inside that nested occurrence too. Call
   `snapshotWorkerRecovery` on the outer repo, then walk the resulting tree:
   assert the gitlink entry's SHA is a real, fetchable commit (`git cat-file
   -e <sha>`) and that commit's tree contains the nested occurrence's
   uncommitted content. This is the one test that actually exercises
   repositoryIntegration.ts's recursive substitution end to end — write it
   only after confirming (from step 1's reading) how that fixture should be
   constructed, since the gitlink-linking convention lives in that file, not
   in this plan.

Keep each test isolated to one behavior (per tdd.md's granularity rule) —
do not combine, e.g., the idempotency check and the nested-gitlink check
into one test function even though both could share a fixture.

## Naming, per `~/.claude/guides/coding-standards.md`

Use verb-led function names describing what the body does
(`snapshotWorkerRecovery`, not `workerSnapshot`), and full words over
abbreviations (`snapshotId`, not `snapId`). Match whatever prefix/casing
convention the sibling scripts in this repo already use — confirm by reading
`scripts/repositoryIntegration.ts` and `scripts/occurrenceBranchNames.ts`
during the required first read, and adjust the placeholder names above to
match if the repo already has an established prefix style (e.g. if
repositoryIntegration.ts's exports are prefixed `git_...`).

## Out of scope (do not build)

- No automatic pruning/expiry of old recovery refs — the brief doesn't ask
  for cleanup, only for creation and correctness. Add a pruning pass only if
  a later task asks for it.
- No restore/checkout-from-recovery-ref function — the brief's tests only
  require refs to *exist and resolve correctly*, not a restore code path.
- No sequence-numbering/history-of-snapshots-per-checkpoint mechanism — see
  ref-naming-scheme rationale above.
