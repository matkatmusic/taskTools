# Task 20: Receipt verification with per-occurrence and per-parent test execution

Phase 2 of the recursive repository-discovery redesign.

Create scripts/syncVerification.ts: for every synchronization receipt, verify the expected branches and byte, mode, symlink, and deletion equivalence across occurrences; run the related tests in every occurrence; and run the configured complete suite in every distinct affected parent while walking to the root. Fail on missing tests, mismatched trees, branch drift, or test failures. On success, persist a green receipt tied to the converged digest.

Record lastWriterOccurrence. Deduplicate identical repository/test/digest executions, but never skip a distinct parent merely because it contains the same logical child — distinct parent chains must each be validated.

New module only; no production call sites yet. Phase 2 acceptance: all repeated repositories in a RevEng-shaped graph converge to identical tested trees while retaining distinct occurrence branches and parentage.

Tests: mismatched trees, drifted branches, missing test policy, and failing tests each fail verification; identical repo/test/digest runs execute once; two distinct parents containing the same logical child both run their complete suites; a green receipt is persisted only when everything passes and is keyed to the converged digest.

### scripts/syncVerification.ts

(missing: file not found on disk)

### tests/syncVerification.test.ts

(missing: file not found on disk)
