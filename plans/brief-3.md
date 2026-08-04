# Task 3: Non-destructive refusal of legacy flat repository manifests

Phase 1 of the recursive repository-discovery redesign.

Create scripts/legacyManifest.ts: detect run manifests written by the old flat repository-path model (no manifest version, or a version below the one defined in scripts/repositoryManifest.ts) and mark them incompatible with the new finalizer.

A legacy manifest must never be converted implicitly and must never cause a worktree, branch, or ref to be deleted. Return a refusal result carrying the detected version, the reason, and the exact recovery commands a human can run to finish or unwind that run with the existing tooling.

New module only; no call sites in production code yet.

Tests: a versionless manifest and an older-version manifest are both rejected; the rejection result names the recovery commands; a fixture asserts that after refusal every worktree directory and every ref recorded in that manifest still exists; a current-version manifest passes through untouched.

### scripts/legacyManifest.ts

(missing: file not found on disk)

### tests/legacyManifest.test.ts

(missing: file not found on disk)
