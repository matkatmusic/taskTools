# Task 25: Per-repository finalizer: own-files commit, durable refs, gitlink bump commits

Phase 3 of the recursive repository-discovery redesign.

Create scripts/runFinalizer.ts, requiring an authorization from scripts/runAuthorization.ts: finalize logical children first using explicit occurrence edges, then for each repository, in each participating group/occurrence branch, create one nonempty commit containing approved own-file changes only, excluding child gitlinks. Preserve each resulting tip under a run-scoped durable ref. Create one temporary assembly branch at the logical repository's recorded base, set every direct child occurrence to its finalized integration OID, and create one distinct gitlink-bump commit per changed parent gitlink, ordered by path within the immediate parent.

No empty commits are ever created, and own-file commits never contain gitlink changes. This module must not update any base ref and must not push.

New module only; no production call sites yet.

Tests: the own-files commit contains no gitlink change; one separate bump commit exists per changed direct child occurrence and none for unchanged ones; a parent containing multiple occurrences of one logical child updates every one of those gitlinks to the same child integration OID; nested child OIDs propagate through each correct explicit parent edge to the root; durable refs exist for every group tip; base refs are provably unchanged.

### scripts/runFinalizer.ts

(missing: file not found on disk)

### tests/runFinalizer.test.ts

(missing: file not found on disk)

---

# Available primitives (read this before planning)

You may only read this brief, so here is what already exists on the current branch. Plan against these; do not stop to look for anything else.

- `scripts/ownershipSnapshots.ts` — `takeSnapshot(occurrenceRoot): Snapshot`, `diffSnapshots(occurrenceRoot, before, after): Change[]`, `attributeOccurrence(change, occurrenceRoots)`, `checkOwnership(workerId, changes, ownershipKeys): Violation[]`, `checkGroupBoundary(changes, allWorkersOwnershipKeys): Violation[]`. `Change = {type: "added"|"deleted"|"modified"|"mode-changed"|"symlink-changed"|"renamed", ...}`. A branch's approved own-file change set is `Change[]` filtered to non-gitlink paths — there is no other type for it, so take it as a parameter rather than searching for one.
- `scripts/repositoryIntegration.ts` — `substituteGitlink(repoRoot, {parentCommitOid, pathInParent, childOid}): string` rewrites one gitlink and returns the new parent commit OID; `substituteGitlinksRecursively(...)` folds that bottom-up over a full ancestor chain and returns every intermediate OID; `prepareNoFfMerge(...)`. None of them move a ref.
- `scripts/runAuthorization.ts` — the opaque digest-bound token the finalizer must require.
- `scripts/ownershipKeys.ts` — canonical ownership keys and `OwnershipEffects`.
- `scripts/logicalRepository.ts`, `scripts/repositoryGraph.ts` — `LogicalRepository`, `RepositoryOccurrence`, occurrence edges and recorded bases.

If a type you want does not exist in that list, define it locally in `scripts/runFinalizer.ts` as an input parameter. Do not stop and report the task blocked for a missing type.
