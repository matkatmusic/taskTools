# Task 6: Base-branch candidate matching by exact tip OID

Phase 1 of the recursive repository-discovery redesign.

Create scripts/baseBranchResolution.ts: for a repository checked out at a recorded OID, fetch branch refs and return every branch whose tip OID exactly equals that recorded OID. No fuzzy matching, no ancestry checks, no preference for a branch merely because it contains the commit.

The result distinguishes three cases explicitly: exactly one match (usable as baseBranch), zero matches, and multiple matches. Zero and multiple are not errors here — they are returned as candidate sets for the resolution-request module to turn into a question.

New module only; no production call sites yet.

Tests: a repo where exactly one branch tip equals the recorded OID yields that branch as the sole match; a repo where two branches point at the same commit yields both, in deterministic order; a repo where the recorded OID is an ancestor of every branch tip but the tip of none yields zero matches; assert a branch that merely contains the commit is never reported as a match.

### scripts/baseBranchResolution.ts

(missing: file not found on disk)

### tests/baseBranchResolution.test.ts

(missing: file not found on disk)
