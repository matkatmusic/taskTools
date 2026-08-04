# Task 10: Integration primitives: gitlink substitution and prepared no-ff merge

Phase 1 of the recursive repository-discovery redesign.

Create scripts/repositoryIntegration.ts with two primitives used by later phases:

1. Substitute a finalized child OID into the correct direct gitlink of its immediate parent, located by the explicit occurrence edge and the recorded path within that parent. Only the declared gitlink changes; every other entry in the parent tree is byte-identical.

2. Prepare a real --no-ff merge commit from a recorded base to a given tip, returning the prepared commit OID, without moving any branch ref.

Neither primitive may update a branch, and neither may touch a base ref. On conflict, return repository-qualified conflict information instead of leaving a half-finished state. Phase 3 composes these across task groups; this task delivers the primitives and their tests only.

Tests: substituting a child OID changes exactly one gitlink entry and leaves every sibling entry unchanged; a parent containing two gitlinks pointing at the same child path prefix updates only the declared one; a prepared --no-ff merge produces a real merge commit with two parents while refs/heads is provably unchanged before and after; a conflicting merge returns a repository-qualified conflict and moves nothing.

### scripts/repositoryIntegration.ts

(missing: file not found on disk)

### tests/repositoryIntegration.test.ts

(missing: file not found on disk)
