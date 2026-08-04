# Task 30: readyForApproval gating and reviewer exercise-method handoff

Phase 4 of the recursive repository-discovery redesign.

Create scripts/approvalReadiness.ts: set readyForApproval only when every selected task is done, ownership checks and typechecks pass, repeated occurrences have converged, final test receipts from scripts/syncVerification.ts are green, and each group provides an exercise method. A report-only reviewer must return at least one actionable method per group — a live server URL, or an exact command plus its working directory.

Partial, blocked, clarification, ownership, typecheck, sync, test, or missing-review results keep the run recoverable but never approvable. The reviewer is report-only and must not modify the run.

Tests: each failing input (partial task, ownership violation, typecheck failure, unconverged occurrence, red or missing receipt, missing review, non-actionable review) independently prevents readyForApproval; a fully green run with an actionable method per group becomes ready; a reviewer returning only prose without a URL or command plus working directory is rejected; the reviewer performs no writes.

### scripts/approvalReadiness.ts

(missing: file not found on disk)

### tests/approvalReadiness.test.ts

(missing: file not found on disk)
