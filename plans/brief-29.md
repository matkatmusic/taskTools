# Task 29: Run-scoped recovery refs after each worker and each synchronization

Phase 4 of the recursive repository-discovery redesign.

Create scripts/recoveryRefs.ts: preserve work after each worker and after each N-way synchronization using internal run-scoped recovery refs. Build recovery snapshots with temporary indexes and recursive gitlink substitution via scripts/repositoryIntegration.ts, without moving any operation or base branch.

Recovery must capture the full recursive state, including nested occurrence contents, so a killed run loses nothing. Snapshotting must be safe to repeat and must never disturb the working tree a worker is using.

Tests: a recovery ref exists after each worker and each sync and resolves to a tree containing that state; operation and base branches are provably unmoved; nested occurrence contents are reachable through substituted gitlinks; repeated snapshots are idempotent; a snapshot taken with uncommitted worker changes still captures them.

### scripts/recoveryRefs.ts

(missing: file not found on disk)

### tests/recoveryRefs.test.ts

(missing: file not found on disk)
