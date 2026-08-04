# Task 18: Per-occurrence test policy with related-test map and complete-suite command

Phase 2 of the recursive repository-discovery redesign.

Create scripts/testPolicy.ts: attach an explicit test policy to each occurrence — a related-test mapping used for ordinary edits, and a complete suite command used for parent validation. Discover commands from repository configuration (package.json scripts and equivalents) only when the choice is unambiguous; when it is ambiguous or absent, emit a setup resolution request through scripts/resolutionRequests.ts instead of guessing a command.

A missing or unresolved test policy is a blocking condition for that occurrence, not a warning to skip past.

New module only; no production call sites yet.

Tests: an unambiguous test script is discovered and recorded; two equally plausible candidates produce a resolution request rather than a pick; a repository with no test configuration produces a request; a persisted answer is reused on the next run; occurrences of one logical repository may carry the same policy while remaining separately recorded.

### scripts/testPolicy.ts

(missing: file not found on disk)

### tests/testPolicy.test.ts

(missing: file not found on disk)
