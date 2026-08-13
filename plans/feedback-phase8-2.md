# Phase 8–9 remediation feedback, round 2

Review target: frozen staged tree `eee89f76ecf06d72ad4069f49163b2d1b8d72aef`.
This pass is limited to the unresolved items published in `plans/feedback-phase8-1.md`.
`plans/implementation-notes-phase8-9-remediation.md` was also read.

## Unresolved finding

### 3. A live rebase with no result receipt is still classified as safe to rerun

The new step-result receipts correctly replay successful, conflicted, and test-failed returns
when `persistRebaseStepResult()` completes. However, the exact unsafe gap called out in the prior
feedback remains when the process dies after starting/advancing a rebase but before that receipt
is appended. `reconcileRebase()` checks for a receipt, then returns `not-completed` whenever any
layer has a live rebase (`scripts/tackle-tasks/reconcileStep.ts:389-407`). Under the Phase 8
contract, `not-completed` authorizes the workflow to rerun the mutating box. The same observable
state can mean either:

- `rebaseTaskWorktree` or `advanceTaskRebase` never ran far enough to return, so retry may be
  appropriate; or
- it produced a new conflict outcome and died immediately before
  `persistRebaseStepResult()`, so retrying repeats a mutation against the live partial rebase.

Those histories are indistinguishable without additional durable intent. The existing conflict
tests cover only the case where the receipt write succeeded; they do not inject failure between
the rebase mutation and `appendStepResult()`.

When a matching result receipt is absent and any layer has a live rebase, return `ambiguous`, not
`not-completed`, unless additional pre-mutation durable evidence proves which safe action applies.
Keep replaying the exact result when a matching, live-state-valid receipt exists. A clean idle
worktree with no receipt may remain `not-completed` where rerunning is proved idempotent.

Add fault-injection tests for both `rebaseTaskWorktree` and `advanceTaskRebase` that leave the
root or nested layer in the live-conflict state while suppressing/removing the step-result receipt,
then reconcile the same `stepId` and require `ambiguous`. Retain the existing paired tests proving
the identical live conflict plus a valid receipt returns `completed` with the exact original
result.

## Resolved from the prior feedback

Findings 1, 9, and 10 are resolved. In particular, the implementation-notes open question about
the byte-identical `closeTaskRun` retry path is acceptable: without a receipt it returns
`ambiguous`, which is the safe alternative explicitly allowed by the prior feedback, rather than
fabricating `unblocked`. Phase 10 must still supply distinct logical step IDs to every newly
receipt-bearing call.

## Verification

- `npx tsc --noEmit` — passed.
- Phase 8–9 targeted tests — passed.
- Full test suite — passed.
