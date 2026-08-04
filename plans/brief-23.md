# Task 23: Snapshot-based worker ownership checks replacing commit ranges

Phase 3 of the recursive repository-discovery redesign.

Create scripts/ownershipSnapshots.ts: replace commit-based worker ownership checks with before/after recursive snapshots covering tracked, untracked, deleted, renamed, mode, and symlink states across every occurrence. Attribute each worker's delta to its declared ownership from scripts/ownershipKeys.ts, and keep the group boundary as the final check.

Snapshots must work when a worker made no commit, several commits, or amended one, since commit ranges are exactly what this replaces. Out-of-ownership changes are reported repository-qualified so a human can see which occurrence and path violated the fence.

New module only; no production call sites yet.

Tests: an edit outside declared ownership is reported even with no commits made; edits inside ownership pass; deletions, renames, mode changes, and symlink changes are all attributed correctly; a change inside a nested occurrence is attributed to that occurrence rather than its parent; the group boundary still rejects a change owned by no task in the group.

### scripts/ownershipSnapshots.ts

(missing: file not found on disk)

### tests/ownershipSnapshots.test.ts

(missing: file not found on disk)
