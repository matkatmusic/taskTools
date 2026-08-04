# Task 8: Run-scoped operation branch creation at the recorded OID

Phase 1 of the recursive repository-discovery redesign.

Create scripts/operationBranches.ts: for each occurrence, create and check out the run-scoped operation branch at that occurrence's recorded OID (not at whatever HEAD happens to be), and record the branch name on the occurrence.

Setup must stop before any worker worktree is created if a repository is on a detached HEAD or its base branch is still unresolved. Failure is loud and names the offending occurrence paths. Creating a branch that already exists at the same OID is idempotent so a resumed run is safe; an existing branch at a different OID is an error, not a silent reset.

New module only; no production call sites yet.

Tests: branches are created at the recorded OID even when the checkout is elsewhere; re-running is a no-op; an existing branch at a different OID errors; a detached-HEAD occurrence aborts setup and the error names it; an occurrence with no resolved baseBranch aborts setup; assert no worker worktree directory is created on any of those failure paths.

### scripts/operationBranches.ts

(missing: file not found on disk)

### tests/operationBranches.test.ts

(missing: file not found on disk)
