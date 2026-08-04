# Task 17: Copy the Jot related-test hook into taskTools and batch by owning repository

Phase 2 of the recursive repository-discovery redesign.

Copy the Jot related-test hook into taskTools as scripts/relatedTests.ts, including its entry point, without modifying Jot itself. Extend the copy so it resolves each edited file's nearest Git root and batches the related tests by owning occurrence, so a file edited inside a nested submodule runs that submodule's tests rather than the parent's.

Ownership resolution uses the occurrence graph, not path prefixes. Deliver the module and its entry point here; registration in hooks/hooks.json is deliberately deferred to the Phase 4 startup task so nothing changes production behaviour yet.

Tests: edited files map to the correct owning occurrence in a three-level fixture; files from several occurrences in one edit set are batched per occurrence rather than merged into one run; a file directly in the root repository maps to the root; assert the Jot source tree is untouched by this task.

### scripts/relatedTests.ts

(missing: file not found on disk)

### tests/relatedTests.test.ts

(missing: file not found on disk)
