# Task 7: Resumable discovery resolution requests with persisted answers

Phase 1 of the recursive repository-discovery redesign.

Create scripts/resolutionRequests.ts: when discovery cannot decide something on its own, emit a resolution request carrying the occurrence ID, the recorded OID, the candidate base branches, and the reason (zero exact tip matches, multiple exact tip matches, or a later phase's ambiguity). Accept a resolution input mapping each request ID to the selected answer, and persist both requests and answers in the run manifest.

Resuming a run must not re-ask a resolved question and must not recreate a worktree that already exists. Request IDs must be stable across runs for the same occurrence and reason so a persisted answer still matches after a restart.

New module only; no production call sites yet.

Tests: a zero-match and a multi-match request are emitted with the right reason and candidates; applying answers stores them in the manifest; a second discovery pass over the same manifest emits no request that already has an answer; request IDs are stable across serialization round trips; an answer naming a branch that is not among the candidates is rejected.

### scripts/resolutionRequests.ts

(missing: file not found on disk)

### tests/resolutionRequests.test.ts

(missing: file not found on disk)
