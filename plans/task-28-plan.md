# Task 28 Plan: scripts/hookOverride.ts — explicit per-run hook-disabled override with manifest recording and pre-approval complete-suite enforcement

Phase 4 of the recursive repository-discovery redesign. Both target files are
new (missing on disk): `scripts/hookOverride.ts`, `tests/hookOverride.test.ts`.

## Preconditions — read before writing any code

This plan was authored from the brief only, without inspecting the repo's
existing modules. Before writing tests or code, the implementing agent MUST:

- Read `scripts/testPolicy.ts` to find the actual exported names/signatures
  for the "related-test" and "complete-suite" commands (task 18 added these
  per-occurrence).
- Find and read the run-manifest module (`grep -rn "manifest" scripts/
  tests/`) to learn how a manifest is loaded, saved, and resumed, and how
  "affected repositories" / "affected parents" are enumerated on it.
- Find and read the existing startup check that stops a run when the
  related-test hook is disabled (`grep -rn "hook" scripts/`) — its exact
  disable-detection mechanism and where it currently aborts startup.
- Skim `scripts/occurrenceBranchNames.ts` and `scripts/relatedTests.ts` for
  the naming/style conventions already established in this redesign, so
  `hookOverride.ts` matches.

Match real exported types/signatures from those modules. The names below are
the contract (what must exist and what it must do), not literal source to
copy — adjust parameter/return types to what's actually there.

## Behavior (plain English, in order)

1. A run can carry an explicit override meaning "proceed even though the
   related-test hook is disabled." It is only ever set by an explicit input
   (CLI flag / manifest field / function argument) — a disabled hook alone
   never implies it.
2. Setting the override writes it into the run manifest.
3. The override survives a resume: reloading the manifest after resume shows
   it still active without the caller re-supplying it.
4. Regardless of the override, before a run is approved, the complete suite
   (`scripts/testPolicy.ts`'s complete-suite command) must run for every
   affected repository and every affected parent. The override unblocks the
   disabled-hook startup check only — it never skips this verification.
5. These complete-suite runs happen immediately before approval, not earlier
   in the run and not reused from an earlier stage. Approval blocks on this
   immediate run.
6. Any complete-suite failure blocks approval.
7. Without the override, a disabled related-test hook still stops the run at
   startup, before approval or complete-suite execution is reached.

## Public surface — scripts/hookOverride.ts

Thin orchestration only: delegate suite execution to `testPolicy.ts` and
manifest I/O to the existing manifest module. Do not reimplement either.

- `isHookOverrideRequested(input): boolean` — true only when the explicit
  override input is present; no implicit default to true.
- `recordHookOverrideInManifest(manifest, overrideRequested: boolean): Manifest`
  (match the existing manifest module's mutate/return convention) — persists
  the flag so it round-trips through save/load.
- `assertHookOverrideOrStopStartup(hookDisabled: boolean, overrideActive: boolean): void`
  — throws/exits when `hookDisabled && !overrideActive`. Wire this into the
  single existing spot where the related-test hook's disabled state is
  currently detected and startup currently stops, so there is exactly one
  place this decision is made.
- `runCompleteSuitesBeforeApproval(affectedRepositories: string[], affectedParents: string[]): SuiteResult[]`
  (name/shape adjusted to testPolicy's real complete-suite entry point) —
  calls it once per entry in both lists; called only from the approval path.
- `blockApprovalOnSuiteFailure(results: SuiteResult[]): boolean` — false (or
  throws, match existing approval-path convention) if any suite failed.

## Wiring points

- Startup: find the existing disabled-hook check and route it through
  `assertHookOverrideOrStopStartup` so override is the only bypass.
- Approval: find the existing approval step in the run/orchestration flow
  and insert `runCompleteSuitesBeforeApproval` + `blockApprovalOnSuiteFailure`
  immediately before approval is granted — not at the point affected
  repos/parents are first discovered, and not reusing an earlier-stage
  result.

## Test order — strict red-green TDD, one behavior per test

Write `tests/hookOverride.test.ts` first. For each test: write it (RED),
confirm it fails, write the minimum code to pass (GREEN), then move on.
Name each `test_<behavior>` with plain-English step comments above the code
(see `~/.claude/guides/tdd.md`). Build fixtures inline per test; only extract
a shared fixture if three or more tests need the identical setup.

1. `test_isHookOverrideRequested_isFalseWhenNoOverrideGiven`
2. `test_isHookOverrideRequested_isTrueWhenExplicitOverrideGiven`
3. `test_recordHookOverrideInManifest_persistsOverrideFlag` — record true,
   assert the serialized/saved manifest carries the flag.
4. `test_hookOverride_survivesResume` — record true, save, reload (simulate
   resume), assert the flag is still true post-reload with no re-supply.
5. `test_assertHookOverrideOrStopStartup_stopsWhenHookDisabledAndNoOverride`
   — hookDisabled=true, overrideActive=false → throws/stops.
6. `test_assertHookOverrideOrStopStartup_proceedsWhenOverrideActive` —
   hookDisabled=true, overrideActive=true → no throw.
7. `test_runCompleteSuitesBeforeApproval_runsSuiteForEveryAffectedRepoAndParent`
   — mock/spy testPolicy's complete-suite call; assert it's invoked once per
   entry across both the repos list and the parents list.
8. `test_blockApprovalOnSuiteFailure_blocksWhenAnySuiteFails` — one failing
   `SuiteResult` among passing ones → approval blocked.
9. `test_blockApprovalOnSuiteFailure_allowsWhenAllSuitesPass` — all pass →
   approval proceeds.
10. `test_hookOverride_doesNotSkipCompleteSuiteRun` — override active=true,
    still assert `runCompleteSuitesBeforeApproval` is called and a failure
    in it still blocks approval (override never implies skipping tests).
11. `test_completeSuiteRuns_happenImmediatelyBeforeApprovalNotEarlierStage`
    — simulate an earlier-stage related-test check having already run and
    passed, then assert the complete-suite call still happens fresh at the
    approval step (proves it isn't reused from an earlier stage).

## Non-goals

- No implicit fallback that silently proceeds when the hook is disabled and
  no override was given — test 5 guards this and must never be weakened.
- Do not change `scripts/testPolicy.ts`'s own logic; only call its existing
  complete-suite entry point.
- Do not change the manifest schema beyond the one override field; do not
  touch unrelated manifest fields.

## Definition of done

- `scripts/hookOverride.ts` exists, thin, delegates to `testPolicy.ts` and
  the manifest module.
- `tests/hookOverride.test.ts` exists with all 11 tests above passing.
- No file changes outside the two new files plus the two minimal wiring
  edits (startup check call-site, approval step call-site) found during the
  preconditions step.
