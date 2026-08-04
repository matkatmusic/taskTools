# Task 19: Machine-readable synchronization receipts

Phase 2 of the recursive repository-discovery redesign.

Create scripts/syncReceipts.ts: a sync-receipt mode emitting a machine-readable record for each synchronization, containing the logical repository ID, the source and destination occurrences, the changed paths, the expected branches, the content digests, and each occurrence's full parent chain.

The parent chain is part of the receipt because verification must later run the complete suite in every distinct affected parent, and two occurrences of the same logical child can sit under entirely different chains.

New module only; no production call sites yet.

Tests: a receipt from a three-occurrence sync lists all destinations, their branches, digests, and distinct parent chains; receipts serialize and parse losslessly; a receipt for a nested occurrence records the full chain to the root, not just the immediate parent; two occurrences of one logical child under different parents produce receipts with different chains.

### scripts/syncReceipts.ts

(missing: file not found on disk)

### tests/syncReceipts.test.ts

(missing: file not found on disk)
