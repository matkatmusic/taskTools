# Task 33: Local base publication with compare-and-swap, rollback, and recovery commands

Phase 4 of the recursive repository-discovery redesign.

Create scripts/basePublication.ts: publish only after the root integration OID exists. Revalidate all recorded base OIDs and every approval input first, then update one canonical local base ref per logical repository using compare-and-swap semantics, and align other local occurrences' base branches through local fetch and fast-forward. If any update fails, roll back the already-updated refs to their recorded OIDs. If publication or rollback is incomplete, preserve the integration and recovery refs and report exact recovery commands.

Rollback must not stop at the first failure in a way that leaves advanced repositories without recovery instructions — every repository's state and its recovery command must be reported.

Tests: a base ref that moved since approval blocks publication entirely; compare-and-swap prevents clobbering a concurrent update; a mid-sequence failure rolls back every already-updated ref to its recorded OID; a failing rollback preserves integration and recovery refs and reports an exact command per affected repository; other occurrences fast-forward locally without a remote push; nothing publishes before the root integration OID exists.

### scripts/basePublication.ts

(missing: file not found on disk)

### tests/basePublication.test.ts

(missing: file not found on disk)
