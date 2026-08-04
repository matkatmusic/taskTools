# Task 7 Plan: Resumable discovery resolution requests with persisted answers

Source: `plans/brief-7.md` (Phase 1 of the recursive repository-discovery redesign).

## Scope

New module only: `scripts/resolutionRequests.ts` + `tests/resolutionRequests.test.ts`.
No existing file wires into this module yet ("no production call sites yet" per brief) —
do not touch any other file. Neither target file exists on disk; both are created fresh.

## Assumptions (state up front, since nothing in the repo can be inspected for this plan)

- Test runner: `bun:test` (`import { describe, test, expect } from "bun:test"`), per this
  user's global preference for `bun` over `node`/`npm`. If the implementing agent finds the
  repo actually uses a different runner when it opens the tests directory, match that instead —
  this is a default, not a hard requirement.
- "Run manifest" does not exist as a concrete type anywhere yet for this feature line, so this
  module defines the slice of it that belongs to resolution requests/answers
  (`ResolutionManifest`). A later phase that builds the real run manifest is expected to embed
  or extend this shape rather than this module reaching out to something that doesn't exist.
- `candidateBaseBranches` for the "zero exact tip matches" reason is an empty array (zero
  matches literally means zero candidates); for "multiple exact tip matches" it is 2+ branch
  names. The module does not enforce array length against the reason — it just stores what the
  caller passes — because that enforcement is a discovery-logic concern (a later phase), not
  this module's.

## Design (the "how", with the "why" for each non-obvious choice)

### Types and constants

```ts
export type ResolutionReason = string;

export const REASON_ZERO_EXACT_TIP_MATCHES: ResolutionReason = "zero-exact-tip-matches";
export const REASON_MULTIPLE_EXACT_TIP_MATCHES: ResolutionReason = "multiple-exact-tip-matches";

export interface ResolutionRequest {
    id: string;
    occurrenceId: string;
    recordedOid: string;
    candidateBaseBranches: string[];
    reason: ResolutionReason;
}

export interface ResolutionManifest {
    resolutionRequests: ResolutionRequest[];
    resolutionAnswers: Record<string, string>;
}
```

Why `ResolutionReason` is `string` and not a strict union: the brief names two concrete reasons
now (zero/multiple exact tip matches) but explicitly says a third category is "a later phase's
ambiguity" — a reason this module can't enumerate yet. A plain `string` with two exported
constants gives call sites the two known values without locking out reasons phase 2+ will add.
Don't build a closed enum for a value that's already known to grow — that's the kind of
speculative rigidity the ladder says to skip.

Why `resolutionAnswers` is `Record<string, string>` keyed by request id rather than an array of
`{requestId, branch}` pairs: answer lookup by request id is the only operation any caller needs
(`hasResolutionAnswer`, `needsResolutionRequest`), and a plain object gives O(1) lookup for free
via the language's own object model — no extra Map wrapper, no lookup helper to write.

### Request id — stable, deterministic, no state needed to recompute it

```ts
import { createHash } from "node:crypto";

export function createResolutionRequestId(occurrenceId: string, reason: ResolutionReason): string {
    const hash = createHash("sha256").update(`${occurrenceId}::${reason}`).digest("hex");
    return `rr_${hash.slice(0, 16)}`;
}
```

Why a hash of `occurrenceId::reason` and nothing else: the brief is explicit — "Request IDs
must be stable across runs for the same occurrence and reason." `recordedOid` and
`candidateBaseBranches` are excluded from the id input on purpose: if either drifted slightly
between two discovery passes over the same occurrence/reason (e.g. a branch list re-ordered, or
re-fetched), including them would silently mint a new id and orphan the previously-persisted
answer — exactly the bug the brief is guarding against. `node:crypto` is Node/Bun stdlib
(rung 3 of the ladder) — no hashing dependency to add.

Why this is a pure function taking `(occurrenceId, reason)` rather than being folded only into
`createResolutionRequest`: `needsResolutionRequest` (below) has to compute the same id from just
an occurrence + reason, before any `ResolutionRequest` object exists, to answer "would this
question already be answered if I asked it?" without constructing a throwaway request object
first.

### Building and recording requests

```ts
export function createEmptyResolutionManifest(): ResolutionManifest {
    return { resolutionRequests: [], resolutionAnswers: {} };
}

export function createResolutionRequest(
    occurrenceId: string,
    recordedOid: string,
    candidateBaseBranches: string[],
    reason: ResolutionReason
): ResolutionRequest {
    return {
        id: createResolutionRequestId(occurrenceId, reason),
        occurrenceId,
        recordedOid,
        candidateBaseBranches,
        reason,
    };
}

export function recordResolutionRequest(manifest: ResolutionManifest, request: ResolutionRequest): void {
    const alreadyRecorded = manifest.resolutionRequests.some((existing) => existing.id === request.id);
    if (alreadyRecorded) return;
    manifest.resolutionRequests.push(request);
}
```

Why `recordResolutionRequest` is a no-op on a repeat id instead of overwriting or throwing: a
resumed run re-runs discovery, which re-derives the same request (same occurrence, same reason,
same stable id) for any occurrence it hasn't resolved yet. That re-derivation must not duplicate
the entry in `resolutionRequests` — this is the concrete mechanism behind "must not recreate a
worktree that already exists" and "must not re-ask a resolved question": callers push whatever
discovery derives, unconditionally, and this function absorbs the duplicate.

Why the manifest is mutated in place (`void` return) rather than returned as a new object: this
module has no other state to track and no concurrent writers to guard against — an immutable
update pattern here would be ceremony with no consumer. Mutating a plain data bag the caller
owns is the smaller diff.

### Answering requests

```ts
export function hasResolutionAnswer(manifest: ResolutionManifest, requestId: string): boolean {
    return Object.prototype.hasOwnProperty.call(manifest.resolutionAnswers, requestId);
}

export function needsResolutionRequest(
    manifest: ResolutionManifest,
    occurrenceId: string,
    reason: ResolutionReason
): boolean {
    const id = createResolutionRequestId(occurrenceId, reason);
    return !hasResolutionAnswer(manifest, id);
}

export function applyResolutionAnswers(manifest: ResolutionManifest, answers: Record<string, string>): void {
    for (const [requestId, selectedBranch] of Object.entries(answers)) {
        const request = manifest.resolutionRequests.find((candidate) => candidate.id === requestId);
        if (!request) {
            throw new Error(`No resolution request found with id "${requestId}"`);
        }
        if (!request.candidateBaseBranches.includes(selectedBranch)) {
            throw new Error(
                `"${selectedBranch}" is not among the candidate base branches for request "${requestId}": ${request.candidateBaseBranches.join(", ")}`
            );
        }
        manifest.resolutionAnswers[requestId] = selectedBranch;
    }
}
```

Why `applyResolutionAnswers` takes the whole `Record<string, string>` map in one call: the brief
says "Accept a resolution input mapping each request ID to the selected answer" — that mapping
*is* the input shape, so the public entry point takes it directly rather than forcing every
caller to loop and call a singular `applyResolutionAnswer` themselves.

Why validation happens per-answer inside the loop, immediately before writing: rejecting a
branch that isn't in that request's candidates is stated as a hard requirement in the brief
("an answer naming a branch that is not among the candidates is rejected"). Validating before
the write for each entry, rather than validating the whole batch up front and writing after,
means an earlier valid answer in the same batch call is not silently discarded if a later one in
the batch is invalid — each answer's fate depends only on itself.

Why `needsResolutionRequest` recomputes the id instead of taking a `ResolutionRequest`: this is
the pre-check discovery calls *before* building a request at all — "should I even bother asking
this?" — so it only needs the two pieces of information that determine the id (occurrence,
reason), matching how `createResolutionRequestId` is shaped.

### What's deliberately not built

- No custom serialize/deserialize functions for `ResolutionManifest`. Skipped: it's plain JSON-
  safe data (strings, arrays, a string-keyed record) — `JSON.stringify`/`JSON.parse` already
  round-trip it exactly. Add a custom (de)serializer only if the manifest later needs to carry a
  non-JSON-safe field (e.g. a `Date` or `Map`).
- No worktree-existence check in this module. Skipped: this module has no worktree code and the
  brief scopes this task to "New module only; no production call sites yet." Callers get what
  they need to implement the "don't recreate a worktree" rule themselves via
  `needsResolutionRequest`/`hasResolutionAnswer` (an occurrence already answered is an occurrence
  whose worktree should already exist from a prior run) — add the actual worktree check when the
  phase that owns worktree creation wires into this module.

## Test-driven implementation order

Write `tests/resolutionRequests.test.ts` and `scripts/resolutionRequests.ts` together, one test
at a time, red before green. Each test below names the plain-English behavior first — put that
sentence as a comment block above the test body, per the TDD guide's step-comment convention —
then the minimum code to turn it green. Do not write ahead: only add the pieces of the design
above that the current test requires.

1. **`test_createResolutionRequest_recordsZeroExactTipMatchReason`**
   Scenario: discovery found zero exact tip matches for an occurrence's recorded OID, so the
   request it emits must carry that reason and an empty candidate list.
   Steps: call `createResolutionRequest("occ-1", "abc123", [], REASON_ZERO_EXACT_TIP_MATCHES)`;
   assert `reason`, `candidateBaseBranches`, `occurrenceId`, `recordedOid` on the result match
   the inputs; assert `id` is a non-empty string.
   Green: add the `ResolutionReason`/`ResolutionRequest` types, the two reason constants,
   `createResolutionRequestId`, and `createResolutionRequest`.

2. **`test_createResolutionRequest_recordsMultipleExactTipMatchReason`**
   Scenario: discovery found more than one exact tip match, so the request carries that reason
   and every candidate branch found.
   Steps: call `createResolutionRequest("occ-2", "def456", ["main", "develop"], REASON_MULTIPLE_EXACT_TIP_MATCHES)`;
   assert `reason` and `candidateBaseBranches` match.
   Green: none needed beyond test 1's code — this test only exercises the existing function with
   different inputs, confirming it isn't hardcoded to the zero-match case.

3. **`test_recordResolutionRequest_isIdempotentForRepeatedId`**
   Scenario: a resumed run re-derives the same occurrence/reason request a second time; it must
   not be duplicated in the manifest.
   Steps: `createEmptyResolutionManifest()`; build a request for `("occ-3", "...", [...], REASON_ZERO_EXACT_TIP_MATCHES)`;
   call `recordResolutionRequest` twice with that same request; assert
   `manifest.resolutionRequests.length === 1`.
   Green: add `createEmptyResolutionManifest` and `recordResolutionRequest`.

4. **`test_applyResolutionAnswers_storesAnswerInManifest`**
   Scenario: applying a resolution input that maps a request id to a valid candidate branch
   persists that answer in the manifest.
   Steps: build a manifest with one recorded request whose `candidateBaseBranches` includes
   `"main"`; call `applyResolutionAnswers(manifest, { [request.id]: "main" })`; assert
   `manifest.resolutionAnswers[request.id] === "main"`.
   Green: add `applyResolutionAnswers` (validation branch not exercised yet — happy path only).

5. **`test_applyResolutionAnswers_rejectsBranchNotAmongCandidates`**
   Scenario: an answer naming a branch that isn't one of the request's candidates must be
   rejected and must not be persisted.
   Steps: build a manifest with one recorded request whose `candidateBaseBranches` is
   `["main", "develop"]`; call `applyResolutionAnswers(manifest, { [request.id]: "feature-x" })`
   wrapped in an assertion that it throws; assert `manifest.resolutionAnswers[request.id]` is
   still `undefined` afterward.
   Green: add the `candidateBaseBranches.includes(...)` guard inside `applyResolutionAnswers`.

6. **`test_needsResolutionRequest_falseOnceAnswerStored`**
   Scenario: this is the "second discovery pass" case from the brief — once an occurrence's
   question has an answer, a later pass must see that no request is needed for it.
   Steps: build a manifest; create+record a request for `("occ-6", "...", ["main"], REASON_ZERO_EXACT_TIP_MATCHES)`;
   assert `needsResolutionRequest(manifest, "occ-6", REASON_ZERO_EXACT_TIP_MATCHES) === true`
   before answering; call `applyResolutionAnswers(manifest, { [request.id]: "main" })`; assert
   `needsResolutionRequest(manifest, "occ-6", REASON_ZERO_EXACT_TIP_MATCHES) === false` after.
   Green: add `hasResolutionAnswer` and `needsResolutionRequest`.

7. **`test_resolutionRequestId_stableAcrossJsonRoundTrip`**
   Scenario: a persisted manifest is read back from disk (JSON) after a restart; recomputing the
   id for the same occurrence/reason must still match the id that was stored.
   Steps: compute `idBefore = createResolutionRequestId("occ-7", REASON_MULTIPLE_EXACT_TIP_MATCHES)`;
   build and record the matching request in a manifest; round-trip the manifest through
   `JSON.parse(JSON.stringify(manifest))`; recompute
   `idAfter = createResolutionRequestId(roundTripped.resolutionRequests[0].occurrenceId, roundTripped.resolutionRequests[0].reason)`;
   assert `idBefore === idAfter === roundTripped.resolutionRequests[0].id`.
   Green: no new production code — this test is a regression guard on the design decision in
   `createResolutionRequestId` (hash of occurrence+reason only, no extra state). If it fails,
   the id function is accidentally depending on something JSON round-tripping can perturb.

## File size check

The full module (types, 2 constants, 6 functions) is roughly 70-80 lines — comfortably under
the 250-line file cap with no splitting needed.

## Out of scope / explicitly not part of this task

- Wiring `scripts/resolutionRequests.ts` into any discovery/worktree code — brief says "no
  production call sites yet."
- Building the full run manifest type for the broader discovery redesign — only the
  `ResolutionManifest` slice this task owns.
- CLI or prompt UI for collecting answers from a human — the brief only asks for accepting an
  already-built `requestId -> answer` map.
