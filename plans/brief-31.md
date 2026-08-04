# Task 31: Whole-run approval gate with state digest and drift invalidation

Phase 4 of the recursive repository-discovery redesign.

Create scripts/approvalGate.ts: present exactly one approval gate for the entire run and record the approval against a digest covering the manifest, the files, the operation and base refs, the occurrence digests, the test receipts, and the review handoffs. Issue the authorization from scripts/runAuthorization.ts tied to that digest. Any later drift in any digest input invalidates the approval and returns the run to review.

There is exactly one approval in the run: the whole-run approval authorizes finalization and archival, and no second post-merge approval is added.

Tests: approval cannot be recorded unless readyForApproval; the issued authorization carries the recorded digest; changing any single digest input afterwards — a file, a ref, an occurrence digest, a receipt, or a review handoff — invalidates the authorization and returns the run to review; a stale authorization is rejected by the finalizer; only one gate exists across the run.

### scripts/approvalGate.ts

(missing: file not found on disk)

### tests/approvalGate.test.ts

(missing: file not found on disk)
