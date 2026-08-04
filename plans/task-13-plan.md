# Task 13 Plan: Base and recorded-OID reconciliation gate for repeated repositories

Phase 2 of the recursive repository-discovery redesign. New module only —
`scripts/baseReconciliation.ts` and `tests/baseReconciliation.test.ts` do not
exist yet. No production call sites are wired up in this task.

## Step 0 — Verify the one real unknown before writing code

This plan was written without reading any file except the brief. The only
external dependency this module has is `scripts/resolutionRequests.ts`. Before
writing `scripts/baseReconciliation.ts`:

1. Open `scripts/resolutionRequests.ts` and read its exported functions/types.
2. Map the placeholder names used below (`persistReconciliationRequest`,
   `getPersistedResolution`) onto whatever it actually exports. Do not invent
   a second persistence layer or a second request-shape — reuse whatever
   `resolutionRequests.ts` already provides for creating a request and for
   reading back a previously-recorded answer. If it does not yet expose a
   "read back the persisted answer for an id" function, that is a gap in an
   earlier phase's module, not something to patch inside this file — stop and
   flag it rather than adding storage logic here.
3. Open one existing file under `tests/` to confirm the test runner and
   assertion imports in use (this repo's `CLAUDE.md` prefers `bun`; assume
   `bun:test` unless an existing test file shows otherwise) and match that
   import style exactly in the new test file.

## Plain-English behavior

A "logical repository" is one real repository that recursive discovery found
multiple times (multiple occurrences/worktrees) while walking a task tree.
Each occurrence recorded the git commit (OID) and base branch it started
from. Before anything is allowed to edit, sync, or branch that logical
repository, every occurrence must agree on both the starting OID and the
base branch.

- All occurrences agree → the gate resolves immediately, no request is made.
- Occurrences disagree on OID, or on base branch, or both → the gate blocks,
  and a reconciliation request is persisted (via `resolutionRequests.ts`)
  naming every occurrence and what it recorded, so a human/operator can pick
  a winner.
- Once an answer for that logical repository has been persisted, later calls
  to the gate must return resolved with the winning OID/base branch and must
  not create another request — the persisted answer is authoritative from
  then on, comparison of the raw occurrences is skipped entirely.
- The gate is a hard precondition: the only way calling code finds out it's
  blocked is by a function that throws. There is no "blocked" value that a
  caller could silently log and ignore — code that doesn't check will crash
  loudly, code that does check never reaches the throw.

## Objects and identifiers

| Concept | Identifier | Notes |
|---|---|---|
| One worktree's recorded starting point | `RepositoryOccurrence` | `{ occurrenceId, recordedOid, baseBranch }` |
| Result of checking one logical repository | `BaseReconciliationOutcome` | discriminated union, `status: "resolved" \| "blocked"` |
| The hard-gate function | `assertBaseReconciled` | throws on blocked, narrows type on resolved |
| The comparison/lookup function | `checkBaseReconciliation` | pure-ish; only side effect is persisting a request when blocked and no answer exists yet |

No "logical repository grouping" logic belongs in this file — that's Phase 1
discovery's job. This module receives the occurrences for one already-
identified logical repository and answers one question: can editing proceed.

## `scripts/baseReconciliation.ts` — shape to implement

`checkBaseReconciliation` body, in order:
1. If a persisted answer for `logicalRepositoryId` already exists, return
   resolved with it — do not compare occurrences at all in this branch.
2. Else, if every occurrence shares the same `recordedOid` and `baseBranch`,
   return resolved with that shared pair.
3. Else, persist a reconciliation request naming every occurrence, and
   return blocked.

```ts
export interface RepositoryOccurrence {
    occurrenceId: string;
    recordedOid: string;
    baseBranch: string;
}

export type BaseReconciliationOutcome =
    | { status: "resolved"; recordedOid: string; baseBranch: string }
    | { status: "blocked"; logicalRepositoryId: string };

export function checkBaseReconciliation(
    logicalRepositoryId: string,
    occurrences: RepositoryOccurrence[],
): BaseReconciliationOutcome {
    // see numbered steps above the code block: persisted answer wins, else compare, else persist+block.
}

export function assertBaseReconciled(
    outcome: BaseReconciliationOutcome,
): asserts outcome is Extract<BaseReconciliationOutcome, { status: "resolved" }> {
    // throw new Error(...) when outcome.status === "blocked".  naming the logicalRepositoryId in the message is enough context.
}
```

Do not add a third helper that wraps "assert then run callback" — a caller
does `assertBaseReconciled(outcome); doTheEdit();` and the throw already
prevents `doTheEdit()` from running. Adding a wrapper function is
unrequested abstraction for something one line already covers, and there are
no call sites yet to justify designing their ergonomics.

Do not add a `kind` field to the reconciliation request distinguishing
"OID diverged" vs "base branch diverged" vs both — the brief's two blocking
tests both just need every member's full record (id + oid + base) in the
persisted request; a single member shape covers both cases, no tagging
needed.

## `tests/baseReconciliation.test.ts` — tests to write first (red, then green)

Follow `~/.claude/guides/tdd.md`: one behavior per test, plain-English step
comments in the test body, name each `test_<behavior>`. Write all of these
failing first, then implement `baseReconciliation.ts` until they pass.

1. `test_gateResolvesWhenAllOccurrencesShareOidAndBase`
   - Three occurrences, same `recordedOid`, same `baseBranch`, no persisted
     answer exists yet.
   - Assert `checkBaseReconciliation` returns `status: "resolved"` with that
     shared oid/base.
   - Assert no reconciliation request was persisted (spy/read back through
     `resolutionRequests.ts`).

2. `test_gateBlocksAndRequestsReconciliationOnDivergentOid`
   - Three occurrences, same `baseBranch`, one with a different
     `recordedOid`.
   - Assert the outcome is `status: "blocked"`.
   - Assert a reconciliation request was persisted whose member list contains
     every occurrence's `occurrenceId` and its own `recordedOid`.

3. `test_gateBlocksAndRequestsReconciliationOnDivergentBaseBranch`
   - Same shape as test 2, but the divergent field is `baseBranch` instead
     of `recordedOid` (all OIDs equal).
   - Assert blocked, and the persisted request's member list contains every
     occurrence's `occurrenceId` and its own `baseBranch`.

4. `test_gateResolvesFromPersistedAnswerWithoutEmittingNewRequest`
   - Start from the divergent-OID setup in test 2 so a request already
     exists. Using `resolutionRequests.ts`'s own answer-recording function,
     persist a chosen winning oid/base for that `logicalRepositoryId` (this
     is simulating the operator's resolution, not something
     `baseReconciliation.ts` implements).
   - Call `checkBaseReconciliation` again with the same divergent
     occurrences.
   - Assert it now returns `status: "resolved"` with the persisted winning
     oid/base.
   - Assert no second/duplicate reconciliation request was created (count of
     persisted requests for that id is unchanged from after test 2's setup
     step, i.e. still exactly one).

5. `test_assertBaseReconciledThrowsWhenOutcomeIsBlocked`
   - Build a `{ status: "blocked", logicalRepositoryId: "x" }` outcome
     directly (no need to go through `checkBaseReconciliation` for this
     one — it's testing the assertion function in isolation).
   - Assert calling `assertBaseReconciled(outcome)` throws.

6. `test_assertBaseReconciledPreventsGuardedEditFromRunning`
   - This is the test the brief calls out explicitly: "assert the blocked
     state prevents editing rather than merely reporting."
   - Build a blocked outcome. Define a mock `editRepo` function (a call
     counter is enough, no real git calls).
   - Write the calling pattern a future call site will use:
     ```ts
     try {
         assertBaseReconciled(outcome);
         editRepo();
     } catch {
         // expected when blocked
     }
     ```
   - Assert `editRepo` was never called.
   - Assert `assertBaseReconciled` did throw (i.e. the `catch` branch is the
     one that ran) — use a boolean flag or a thrown-check, not just the
     absence of a call, so the test fails loudly if someone later removes
     the throw and lets `editRepo` slip through silently for the wrong
     reason.

7. `test_assertBaseReconciledAllowsGuardedEditWhenResolved`
   - Sanity check for the same calling pattern as test 6, but with a
     `resolved` outcome: `editRepo` mock IS called, no exception is thrown.

## Order of work

1. Step 0 verification (read `resolutionRequests.ts`, confirm test-runner
   import style).
2. Write the 7 tests above in `tests/baseReconciliation.test.ts` against a
   not-yet-existing `scripts/baseReconciliation.ts` (red).
3. Implement `RepositoryOccurrence`, `BaseReconciliationOutcome`,
   `checkBaseReconciliation`, `assertBaseReconciled` in
   `scripts/baseReconciliation.ts`, wired to the real
   `resolutionRequests.ts` exports found in step 0, until all 7 pass (green).
4. Do not add production call sites — out of scope for this task per the
   brief.

## What's deliberately left out (and when to add it)

- No logical-repository grouping/discovery logic here → belongs to whichever
  Phase 1 module identifies occurrences of the same repository; this file
  only ever receives an already-grouped list.
- No new persistence format for reconciliation requests or answers → reuse
  `resolutionRequests.ts` as-is; if it can't yet store or read back an
  answer, that's a gap to raise, not to silently work around here.
- No `runIfBaseReconciled` convenience wrapper → `assertBaseReconciled(...)`
  followed by the caller's own next line already prevents the edit; add a
  wrapper only once real call sites in a later task show repeated
  boilerplate around it.
