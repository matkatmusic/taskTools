# Phase 8–9 remediation feedback, round 1

Review target: frozen staged tree `efbff6c2fe746144c24958025d85e4e0a0af5394`.
This pass is limited to unresolved items from `plans/phase8-9-audit.md`.

## Unresolved findings

### 1. Retained create journals still do not prove the current run or both ownership records

The recovery added for audit finding 1 is close, but it never compares the retained journal's
`runId` with the `runId` of the current `createTaskWorktree()` call. The current call invokes
`recoverRetainedCreateJournal(...)` without passing its run ID
(`scripts/tackle-tasks/createTaskWorktree.ts:180-186`), and `completedLate` compares task state
only with `journal.runId` (`:161-169`). Therefore a call for run B can consume a completed
journal for run A and return run A's worktree without acquiring or recording ownership for run
B. The read-only classifier has the same problem: it does not receive `input.runId` and can
return `completed` for the journal's older run (`reconcileStep.ts:128-160`).

Both paths also accept completion when the physical lease is absent. They reject only a
different non-null physical owner, then accept task state matching the journal. The original
finding required both authority records to match; task state alone does not prove that the
returned worktree is currently leased to the journal's run.

Pass the requested `runId` into recovery/classification and require the journal, task run state,
and physical lease to name that exact run before returning `completed` or the recovered
worktree. A retained journal for another run, or a state/physical-lease disagreement, must not be
silently adopted or deleted; classify/refuse it according to whether safe recovery can actually
be proved.

Add tests for (a) a completed retained journal owned by run A followed by a create/reconcile call
for run B, and (b) matching task state plus a missing physical lease. Prove neither case returns
run A's worktree as completed for run B and neither destroys an owner it cannot prove.

### 3. Rebase receipts cover only clean success, not every returned mutating result

The new receipt is visit-specific for the happy path, but audit finding 3 also required a
reconstructable result. `rebaseTaskWorktree()` persists it only when both `stoppedAt` and
`failureReason` are null (`scripts/tackle-tasks/rebaseTaskWorktree.ts:196-201`), and
`advanceTaskRebase()` persists it only when `result.finished` is true
(`scripts/tackle-tasks/advanceTaskRebase.ts:155-161`). A call that starts or advances a rebase and
returns a conflict/test-failure result can therefore lose stdout with no visit receipt. The
handler sees a live rebase and returns `not-completed`, causing the mutating box to be run again
instead of reconstructing the conflict/failure edge that already occurred.

Persist a step-ID-tagged result for every returned rebase/advance outcome, including stopped and
failed outcomes, with enough live-state evidence to validate it. Reconciliation must reproduce
that visit's exact result when the evidence still matches; it must not treat a live partial
rebase as proof that rerunning the original mutation is safe.

Add lost-result tests for root and nested conflict outcomes from both scripts, plus a failed-test
outcome where applicable. Discard the real return, reconcile the same `stepId`, and require the
same stopped/failure result; also prove a later step cannot consume it.

### 9. Several builders still interpolate runtime data before later instructions

Adding a final `---- DATA ----` block did not fully resolve audit finding 9 because runtime data
is still spliced into the static portion of several prompts. Examples in the frozen tree include:

- `reviewPlanPrompt()` and `reviewTestsPrompt()` append outer instructions and runtime output
  paths after the nested review question's data (`AgentPromptEmitter.ts:225-232`, `:257-264`).
- `implementPrompt()` embeds the runtime repo root/typecheck command and `maxFixRounds` throughout
  its instructions before the data block (`:272-356`).
- `fixConflictsPrompt()` embeds `checkoutPath` before the block (`:365-403`).
- `fixCodebasePrompt()` embeds the runtime subject and `checkoutPath` before the block
  (`:413-453`).
- `amendTestsPrompt()` embeds `testReviewFile` before the block (`:472-505`).

The new sentinel tests check selected bulk fields, but do not detect these other runtime values.
Make the instruction bodies use symbolic labels only and append every runtime value after the
last instruction/return contract. For nested Codex reviews, the complete emitted prompt still
needs a final data boundary; do not append more runtime paths or static authority after it.

Extend the per-role sentinel tests so every runtime argument—not only notes/failure text—has a
distinctive token, and assert no token occurs before the final data section and no instruction
occurs after it.

### 10. `completed` still returns values the real boxes never returned

The fault-injection coverage added for finding 10 exposes unrecoverable outputs but resolves them
by changing boolean contracts to integer tri-states. That conflicts with the Phase 8/earlier box
contracts (`initTaskSubmodules` is `{"initialized":bool}` at plan line 594;
`releaseTaskRunHolds` has boolean release fields at lines 1040 and 1189). More importantly, the
new module explicitly says real scripts never return the unknown value
(`reconciliationOutcomes.ts:1-16`), while reconciliation returns that value under status
`completed` (`reconcileStep.ts:250-262`, `:492-517`). This is not reconstruction of the lost
stdout: it is a result that the completed box could not have produced.

`closeTaskRun` has the same underlying defect: reconciliation knowingly returns
`unblocked: []` because the real array is no longer observable (`reconcileStep.ts:529-548`). A
real close may have returned non-empty `unblocked`, so the reconstructed result is false even
though the verdict is `completed`.

Keep the production output schemas required by the plan. For output fields that cannot be
derived exactly from end state, persist the step-ID-tagged actual result durably before stdout
and validate that receipt during reconciliation. If exact output truly was never persisted and
cannot be proved, return `ambiguous`; do not invent an `unknown` value under `completed` or a
plausible empty array. Update the per-row fault-injection tests to compare the discarded real
return with the reconciled result exactly, including initialized-true/false, holds released/not
released, and a close that actually unblocks at least one dependent task.

The new tri-state module also makes the full suite fail:
`test_greenBoxPolicy_namesEveryScriptInTheScriptsDirectory` finds
`scripts/tackle-tasks/reconciliationOutcomes.ts` in the directory but not in either policy set.
Removing the contract-widening module as above eliminates that regression; if any replacement
library remains in this directory, keep the required policy/directory coverage invariant valid.

## Verification

- `npx tsc --noEmit` — passed.
- Phase 8–9 targeted tests — passed.
- Full suite — failed at
  `test_greenBoxPolicy_namesEveryScriptInTheScriptsDirectory` because
  `reconciliationOutcomes.ts` is unclassified.
