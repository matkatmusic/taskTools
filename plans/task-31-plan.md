# Task 31 Plan: Whole-run approval gate with state digest and drift invalidation

Source: `plans/brief-31.md` (Phase 4 of the recursive repository-discovery redesign).
Both target files are currently missing from disk — this is greenfield within this plan's scope, but it depends on artifacts from earlier phases (manifest, occurrence digests, test receipts, review handoffs, `scripts/runAuthorization.ts`) that this planning pass did not inspect (planning was scoped to `brief-31.md` only). **Step 0 below is mandatory before writing any code.**

## Step 0 — Inspect before writing (do this first, not optional)

Before implementing, read the actual codebase to find and reuse:
1. `scripts/runAuthorization.ts` — its exported "issue authorization" function, the `Authorization` type, and however it currently exposes/decides staleness. `approvalGate.ts` must call into this, not duplicate it.
2. The manifest module, occurrence-digest module (see task 14 / `occurrenceBranchNames`-adjacent work), test-receipt module (see task 18 / `relatedTests.ts` and related-test/complete-suite commands), and review-handoff module — find their existing types and any existing digest/hash helper before writing a new one.
3. Wherever run state tracks `readyForApproval` (likely a run-state module) — reuse that flag/type, don't reinvent it.
4. The finalizer/archival entry point referenced by "a stale authorization is rejected by the finalizer" — find where it currently checks authorization validity so the new drift check plugs into that one call site.

If any of these don't exist yet under the names guessed above, grep for the closest equivalent (digest, receipt, handoff, authorization, readyForApproval) before creating a new one. Reuse over reinvention.

## Order of implementation (TDD: one failing test, then minimum code, repeat)

### 1. `computeApprovalDigest`
Pure function: takes `{ manifest, files, operationRef, baseRef, occurrenceDigests, testReceipts, reviewHandoffs }` (reuse whatever these types already are per Step 0) and returns a single digest string.
- Implementation: `crypto.createHash('sha256')` (Node stdlib, already a dependency of the runtime — no new package) over a deterministic (key-sorted) JSON serialization of the input. Ponytail rung 3: stdlib covers this, don't write a custom hash or bring in a hashing library.
- `test_computeApprovalDigest_isDeterministicForSameInputs` — same input object twice → identical digest.
- `test_computeApprovalDigest_changesWhenAnySingleInputChanges` — one test per field (manifest, one file, operationRef, baseRef, one occurrence digest, one receipt, one review handoff): mutate only that field from a shared baseline, assert digest differs from baseline. This directly covers the brief's "changing any single digest input... invalidates" requirement at the digest layer; step 5 covers it at the authorization layer.

### 2. `recordApproval(runState)`
- Precondition: `runState.readyForApproval` must be true. If false, throw (e.g. `throw new Error('not ready for approval')`) — do not silently no-op, since a test asserts this is rejected.
- On success: compute the digest via `computeApprovalDigest`, store `{ digest, recordedAt }` as the run's approval.
- `test_recordApproval_throwsWhenNotReadyForApproval`
- `test_recordApproval_succeedsWhenReadyForApproval_andStoresDigest`

### 3. Single-gate constraint
- `recordApproval` must reject a second call for a run that already has an approval recorded (check `runState.approval` is unset before proceeding).
- `test_recordApproval_rejectsSecondApprovalForSameRun` — call once (succeeds), call again on the same run state → throws.
- This is the mechanism that also satisfies "no second post-merge approval is added": there is exactly one code path that can produce an approval, and it self-guards against being called twice. Do not add a second gate function anywhere in the merge/finalize flow — the brief is explicit that a second gate is a defect, not a feature to build.

### 4. Issue authorization tied to the digest
- After `recordApproval` succeeds, call the existing issue function in `scripts/runAuthorization.ts` (found in Step 0), passing the recorded digest so the returned `Authorization` carries it.
- `test_issuedAuthorization_carriesRecordedDigest` — `authorization.digest === approval.digest`.

### 5. Drift detection / invalidation
- Function (name to match whatever `runAuthorization.ts` expects, or `checkAuthorizationDrift(authorization, currentRunState)` if net-new): recompute the digest from current state, compare to `authorization.digest`.
- On mismatch: invalidate the authorization (clear/flag it per whatever mechanism `runAuthorization.ts` already exposes — reuse, don't add a new "invalid" field if one exists) and set run state back to `review`.
- One test per drift source, matching the brief's enumerated list exactly:
  - `test_driftInvalidatesAuthorization_whenFileChanges`
  - `test_driftInvalidatesAuthorization_whenRefChanges`
  - `test_driftInvalidatesAuthorization_whenOccurrenceDigestChanges`
  - `test_driftInvalidatesAuthorization_whenTestReceiptChanges`
  - `test_driftInvalidatesAuthorization_whenReviewHandoffChanges`
  - Each: build a valid approval + authorization on a baseline state, mutate exactly one field, run the drift check, assert the authorization is invalidated and run state reads back as `review`.

### 6. Finalizer rejects stale authorization
- Wire the drift check into the finalizer's existing authorization-check call site (found in Step 0) so finalize/archive refuses to proceed when the authorization no longer matches current state.
- `test_finalizer_rejectsStaleAuthorization` — issue a valid authorization, mutate one input, call the finalizer → it throws/rejects and the run stays out of the finalized/archived state.

### 7. Only one gate exists across the run
- `test_onlyOneApprovalGateExistsAcrossRun` — a run-level test confirming there is exactly one place in the flow capable of producing an `Approval`: run the full sequence (ready → record → issue → merge → finalize) and assert no second `recordApproval`-equivalent call succeeds or is even reachable post-merge (i.e., calling `recordApproval` again after finalize still hits the same single-gate guard from step 3, not a distinct post-merge approval path).

## Files to write

### `scripts/approvalGate.ts`
- Exports: `computeApprovalDigest`, `recordApproval`, the drift/invalidation function, reusing types from the modules identified in Step 0 rather than redeclaring them.
- Imperative style, 4-space indent, no comments restating obvious lines (per coding-standards.md).
- If this can't fit under 250 lines alongside the digest logic, split digest computation into its own module (e.g. `scripts/approvalDigest.ts`) rather than trimming behavior — decide at implementation time based on actual line count.

### `scripts/runAuthorization.ts`
- Touch only if Step 0 shows it's missing an issue/invalidate hook that `approvalGate.ts` needs. If it already exposes what's needed, wire to it — don't rewrite working code (surgical changes only).

### `tests/approvalGate.test.ts`
- One `test_<behavior>` function per bullet above (roughly 12 tests), each with plain-English step comments in the body, per `~/.claude/guides/tdd.md`. Keep each test to one behavior — don't fold multiple drift sources into one test function even though they're similar, per the tdd guide's granularity rule.

## Definition of done
- `scripts/approvalGate.ts` and `tests/approvalGate.test.ts` exist and `bun test tests/approvalGate.test.ts` passes.
- Every test enumerated in the brief's "Tests:" line has a corresponding `test_` function.
- Grep the diff for a second approval/gate function before calling this done — there must be exactly one.

## Explicitly skipped (ponytail)
- No event-emitter/watcher for continuous drift monitoring — the drift check runs only at the two call sites that need it (finalizer, and optionally on-demand). Add a watcher only if a later task needs live invalidation outside those calls.
- No new persistence layer for the `Approval`/`Authorization` objects beyond whatever run-state store already exists — reuse it.
- No new hashing dependency — Node's built-in `crypto` module covers the digest.
