# Task 33 Plan: `scripts/basePublication.ts` — local base publication with CAS, rollback, recovery

Phase 4 of the recursive repository-discovery redesign. Neither `scripts/basePublication.ts` nor
`tests/basePublication.test.ts` exist yet — this is new-file work, not an edit.

This plan was written from `plans/brief-33.md` only (no other repo file was read while planning).
Before writing any code, the implementing agent MUST do the discovery step below — the brief's
vocabulary ("recorded base OIDs", "approval inputs", "root integration OID", "logical repository",
"local occurrences", "integration and recovery refs") is clearly inherited from earlier phases of
this redesign and must not be reinvented.

## 0. Discovery step (do first, before any code)

1. Find the phase-3/earlier scripts that produce or consume: a root integration OID, per-repository
   recorded base OIDs, approval-input state (task 31, commit `059d952`, "whole-run approval gate
   with state digest and drift invalidation"), and the "logical repository / local occurrence"
   model from the repository-discovery phases. Search `scripts/` and `tests/` for these terms.
2. Reuse whatever types/functions already exist for: reading the root integration OID, reading a
   ref's current OID, the approval-state/drift revalidation call, and the logical-repository /
   occurrence data shape. Do not redefine these — import them. If the drift-revalidation function
   from task 31 already exists, call it directly for the "revalidate every approval input" step
   instead of re-implementing drift detection.
3. Check the naming convention already used for "integration" and "recovery" refs so this script
   preserves the exact same ref namespace rather than inventing a new one.
4. Check whether existing scripts use a shared git-command helper (child_process/Bun.spawnSync
   wrapper) already in the repo — reuse it instead of writing a new one.
5. Note the existing test-fixture pattern for git repos in `tests/` (e.g. `tests/runAuthorization.test.ts`)
   and match it — real temp git repos via `bun:test`, no mocking of git.

If any of the above turns out not to exist yet, fall back to the minimal local definitions in
Section 2, but only after confirming absence.

## 1. Scope decisions (why, so these lines can be defended)

- **CAS is native, not hand-rolled.** `git update-ref <ref> <new-oid> <old-oid>` already fails
  atomically if the ref's current value isn't `<old-oid>`. Use this directly for every canonical
  base-ref update and every rollback — no lock file, no custom compare step, no dependency.
- **Fast-forwarding other occurrences is a local fetch, not a merge.** `git fetch <canonical-path>
  <canonicalRef>:<occurrenceRef> --ff-only` both fast-forwards and refuses non-fast-forward moves
  in one native call — no manual merge-base arithmetic, no remote involved.
- **Validation is two-pass, not streaming.** "A base ref that moved since approval blocks
  publication entirely" (test 1) means *no* repo gets updated if *any* repo's recorded OID no
  longer matches reality — even repos that individually still match. So: pass 1 validates every
  repo's current ref against its recorded OID and every approval input, with zero mutations; only
  if pass 1 is clean does pass 2 (the actual CAS updates) begin. Test 2 (CAS clobber) is therefore
  a distinct scenario from test 1: it's a race that happens *during* pass 2, after pass 1 already
  passed — caught by `update-ref`'s own CAS failure, not by the pass-1 check.
- **Rollback scope is the whole run, not the failing repo.** Test 3 ("mid-sequence failure rolls
  back every already-updated ref") means the publish loop tracks every ref (canonical + fast-forwarded
  occurrences) it has successfully touched so far, across *all* logical repositories, and on any
  failure rolls every one of them back — not just the failing repository's own refs.
- **Rollback never short-circuits.** Test 4 requires a rollback failure on one ref to not stop
  rollback attempts on the rest (single-condition-branching guide: no compound early-exit). Loop
  over every tracked ref, attempt rollback, collect a per-ref result, keep going regardless of
  earlier results. Only after the loop completes do you know which refs failed to roll back.
- **Recovery is a reporting job, not a retry job.** For any ref where rollback's own CAS fails
  (someone moved it again), do not retry — report the exact `git update-ref <ref> <recordedOid>`
  command for a human to run, and leave the integration/recovery refs exactly as they are (this
  script must never write to those namespaces at all, so "preserving" them is just "never touch
  them").

## 2. Data shapes (use existing ones from discovery step if found; else define locally)

```ts
type LogicalRepository = {
    name: string;
    canonicalOccurrencePath: string;
    canonicalRefName: string;
    otherOccurrences: { path: string; refName: string }[];
    recordedBaseOid: string;
    targetOid: string;
};

type UpdatedRef = {
    repoName: string;
    occurrencePath: string;
    refName: string;
    recordedOid: string;
};

type RollbackOutcome = {
    ref: UpdatedRef;
    rolledBack: boolean;
    recoveryCommand: string;
};

type PublicationResult = {
    published: boolean;
    rollback: RollbackOutcome[];
};
```

## 3. Functions (verb-named, one behavior each — build in this order, red then green)

1. `checkRootIntegrationOidExists(): boolean`
   Reads the existing root-integration-OID source (from discovery step). No mutation.

2. `readCurrentRefOid(repoPath: string, refName: string): string | null`
   Thin wrapper over `git -C <repoPath> rev-parse --verify --quiet <refName>`.

3. `revalidateRecordedBaseOids(repos: LogicalRepository[]): { ok: boolean; moved: LogicalRepository[] }`
   Pass 1. For every repo, compares `readCurrentRefOid(canonical)` to `recordedBaseOid`. Pure
   check, zero writes. Returns every repo that moved (not just the first) so callers can report
   all of them.

4. `revalidateApprovalInputs(approvalState): boolean`
   Delegates to the task-31 drift-revalidation function found in discovery. If genuinely absent,
   this is the one function allowed a minimal local stub — but confirm absence first.

5. `publishCanonicalRef(repo: LogicalRepository): { ok: boolean; updated?: UpdatedRef }`
   One `git update-ref <canonicalRef> <targetOid> <recordedBaseOid>` call. `ok:false` on CAS
   failure (concurrent mover) — this is test 2's failure path.

6. `fastForwardOtherOccurrences(repo: LogicalRepository): { ok: boolean; updated: UpdatedRef[]; failedAt?: string }`
   For each entry in `otherOccurrences`, run the local `git fetch <canonicalPath>
   <canonicalRefName>:<refName> --ff-only`. Stop this repo's own loop on first failure (the repo
   itself is now in a bad half-updated state and gets rolled back by the caller), but return
   everything fast-forwarded so far in `updated` so the caller can track it for rollback.

7. `rollbackUpdatedRefs(updated: UpdatedRef[]): RollbackOutcome[]`
   Iterate every tracked `UpdatedRef` — no early return. For each: attempt
   `git update-ref <refName> <recordedOid> <currentOid>` (CAS back to recorded). On success,
   `rolledBack:true`. On failure, `rolledBack:false` plus `formatRecoveryCommand(ref)`. Never
   touches integration/recovery refs — those aren't in `UpdatedRef`'s domain at all.

8. `formatRecoveryCommand(ref: UpdatedRef): string`
   One-liner: `` `git -C ${ref.occurrencePath} update-ref ${ref.refName} ${ref.recordedOid}` ``.

9. `publishBases(repos: LogicalRepository[], approvalState): PublicationResult`
   Orchestrator, single-condition-branching throughout:
   - if `!checkRootIntegrationOidExists()` → return `{ published: false, rollback: [] }` immediately
     (test 6). Nothing below runs.
   - if `!revalidateApprovalInputs(approvalState)` → return `{ published: false, rollback: [] }`.
   - `revalidateRecordedBaseOids(repos)`; if any moved → return `{ published: false, rollback: [] }`
     (test 1) — no ref has been touched yet, so nothing to roll back.
   - Pass 2: `updatedSoFar: UpdatedRef[] = []`. For each repo in order:
     - `publishCanonicalRef(repo)`; on failure → break out of the pass-2 loop, go to rollback.
     - on success, push its `UpdatedRef` onto `updatedSoFar`.
     - `fastForwardOtherOccurrences(repo)`; push every occurrence it managed onto `updatedSoFar`
       regardless of its own `ok`; on failure → break out of the pass-2 loop, go to rollback.
   - If pass 2 completed every repo without breaking → return `{ published: true, rollback: [] }`.
   - Otherwise → `rollback = rollbackUpdatedRefs(updatedSoFar)`; return `{ published: false, rollback }`.

## 4. File layout / 250-line cap

Write everything into `scripts/basePublication.ts` first. If it's approaching ~220 lines, split
*before* finishing rather than after: move functions 2, 5, 6 (the raw git CAS/fetch primitives)
into `scripts/basePublicationGit.ts`, and functions 7–8 (rollback + recovery formatting) into
`scripts/basePublicationRecovery.ts`. `scripts/basePublication.ts` keeps 1, 3, 4, 9 (the
orchestration + revalidation) and imports the rest. Only split this way if the cap actually forces
it — don't pre-split speculatively.

## 5. Tests — `tests/basePublication.test.ts`, one `test_<behavior>` per brief requirement

Each test builds real temp git repos (bun:test + a tmp dir per test, matching the existing
fixture pattern found in discovery step 5) — no mocked git calls. Write each RED, then add just
enough of the functions above to go GREEN, in this order:

1. `test_nothingPublishesBeforeRootIntegrationOidExists`
   Steps: no root integration OID recorded. Call `publishBases`. Assert `published === false` and
   assert no ref in any test repo changed value.

2. `test_baseRefMovedSinceApprovalBlocksPublicationEntirely`
   Steps: two logical repos, both with valid recorded OIDs matching current refs except one repo's
   canonical ref is manually moved after "approval". Call `publishBases`. Assert `published ===
   false` and assert *neither* repo's canonical ref changed (the untouched one included) — proves
   the block is whole-run, not per-repo.

3. `test_compareAndSwapPreventsClobberingConcurrentUpdate`
   Steps: one logical repo, recorded OID matches current ref at revalidation time. Between
   revalidation and the CAS `update-ref` call, simulate a concurrent mover by moving the ref
   directly (e.g. drive `publishCanonicalRef` directly with a stale `recordedBaseOid` param, or
   move the ref via a hook/spy point exposed by the discovery step's git helper). Assert
   `publishCanonicalRef` reports `ok:false` and the ref still holds the concurrent value, not the
   attempted target.

4. `test_midSequenceFailureRollsBackEveryAlreadyUpdatedRefToRecordedOid`
   Steps: three logical repos in order; repos 1 and 2 will succeed, repo 3's canonical CAS is
   forced to fail (pre-move its ref). Call `publishBases`. Assert repos 1 and 2's canonical refs
   (and any fast-forwarded occurrence refs) are back at their original `recordedBaseOid`, and
   `published === false`.

5. `test_failingRollbackPreservesIntegrationAndRecoveryRefsAndReportsExactCommandPerRepository`
   Steps: same three-repo setup as above, but after repo 1 and 2 succeed and repo 3 fails, force
   repo 1's ref to be moved again (by a "concurrent" actor) before rollback runs, so rollback's
   own CAS on repo 1 fails while repo 2's rollback succeeds. Assert: repo 2 appears with
   `rolledBack:true`; repo 1 appears with `rolledBack:false` and a `recoveryCommand` string equal
   to the exact expected `git -C <path> update-ref <ref> <oid>` text; assert the integration ref
   and the recovery ref (whatever refs discovery step identified) are byte-for-byte unchanged
   before and after the call.

6. `test_otherOccurrencesFastForwardLocallyWithoutRemotePush`
   Steps: one logical repo with a canonical occurrence and one other occurrence on the same
   machine (temp dir), no remote configured on either. After a successful `publishBases`, assert
   the other occurrence's ref now equals the canonical's new OID, and assert no `git remote` /
   push command was ever invoked (e.g. by asserting the other-occurrence repo still has zero
   configured remotes, proving the fast-forward path never added or used one).

## 6. Explicit non-goals (ponytail)

- No lock files, no distributed-lock library, no retry/backoff loop on rollback — `update-ref`'s
  own CAS is the entire concurrency mechanism.
- No new git wrapper library — shell out via whatever `Bun.spawnSync`/child_process helper already
  exists in the repo (found in discovery step); add a tiny one only if truly nothing exists.
- No generic "N-phase saga" abstraction — this is one fixed two-pass sequence (validate-all, then
  update-all-or-rollback-all), not a reusable transaction framework. Build exactly this sequence.
