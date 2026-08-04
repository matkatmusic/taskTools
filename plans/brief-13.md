# Task 13: Base and recorded-OID reconciliation gate for repeated repositories

Phase 2 of the recursive repository-discovery redesign.

Create scripts/baseReconciliation.ts: when the occurrences of one logical repository start at different recorded OIDs or different base branches, block all editing of that logical repository until a reconciliation choice is persisted through scripts/resolutionRequests.ts.

The gate is a hard precondition, not a warning: no synchronization, no worker edits, and no branch creation for that logical repository proceed while it is unresolved. A persisted choice records which base/OID won and applies on resume without re-asking.

New module only; no production call sites yet.

Tests: three occurrences at one OID and one base pass the gate; a divergent recorded OID blocks and emits a reconciliation request naming every member and its OID; a divergent base branch blocks likewise; after a persisted answer the gate passes and re-running emits no new request; assert the blocked state prevents editing rather than merely reporting.

### scripts/baseReconciliation.ts

(missing: file not found on disk)

### tests/baseReconciliation.test.ts

(missing: file not found on disk)
