# Task 26: Run consolidation into one operation and integration OID per logical repository

Phase 3 of the recursive repository-discovery redesign.

Create scripts/runConsolidation.ts: fetch and merge every participating group/occurrence branch into the assembly branch with --no-ff, ordered by group ID and then occurrence path. Verify the resulting projected tree equals the approved converged tree plus the finalized child gitlinks. Name the result as the run-level operation branch in the canonical occurrence and fast-forward every participating occurrence branch to its OID. Then prepare one real --no-ff integration merge from the recorded base to the operation tip, using scripts/repositoryIntegration.ts, without moving baseBranch.

For a repeated logical repository, the canonical occurrence is lastWriterOccurrence, retaining its path-suffixed branch name; all occurrence and group tips must remain ancestors of the canonical operation OID. Produce exactly one prepared integration OID per logical repository for the whole run — never competing per-group base updates. If any merge conflicts or produces an unapproved tree, preserve every ref, return repository-qualified conflicts, and require testing and approval to be renewed later.

New module only; remote pushes, base-ref updates, and task archival stay disabled. Phase 3 acceptance: arbitrary parallel group histories consolidate deterministically into one verified operation and integration OID per logical repository without publishing anything.

Tests: two disjoint groups in one logical repository both become ancestors of one run-level operation branch; merge order is deterministic; a tree mismatch aborts with every ref preserved; a conflict returns repository-qualified results and leaves base refs untouched; exactly one prepared integration OID exists per logical repository.

### scripts/runConsolidation.ts

(missing: file not found on disk)

### tests/runConsolidation.test.ts

(missing: file not found on disk)

---

# Available primitives (read this before planning)

You may only read this brief, so here is what already exists on the current branch. Plan against these; do not stop to look for anything else.

- `scripts/repositoryIntegration.ts` — `prepareNoFfMerge(repoRoot, baseOid, tipOid, message): PrepareMergeResult` builds a --no-ff merge commit via `merge-tree --write-tree` plus `commit-tree` and returns `{merged: true, commitOid}` or `{merged: false, conflict: {repoRoot, conflictedPaths}}`. It moves no ref. Also `substituteGitlink`, `substituteGitlinksRecursively`, `GitlinkChainLink`, `RepositoryQualifiedConflict`. Use `RepositoryQualifiedConflict` as the repository-qualified conflict shape — do not invent another.
- `scripts/runFinalizer.ts` — `runFinalizer(input, token, currentStateDigest): FinalizationRunResult`. `FinalizationRunResult = {runId, occurrences: OccurrenceFinalizationResult[]}` and `OccurrenceFinalizationResult = {occurrenceId, ownFilesCommitOid, durableTipRef, finalizedIntegrationOid, assemblyBranchRef, bumpCommits}`. The finalized child gitlink OIDs this task consumes are the `finalizedIntegrationOid` values.
- `scripts/logicalRepository.ts` — `LogicalRepository`, `buildLogicalRepositories(occurrences)`, `ConsolidationState`.
- `scripts/occurrenceBranchNames.ts` — `occurrenceBranchNames(...)` for path-suffixed occurrence branch names.
- `scripts/syncReceipts.ts` — `SyncReceipt`, `buildSyncReceipt`, `serializeSyncReceipt`, `parseSyncReceipt`; receipts carry occurrences, digests and parent chains. `lastWriterOccurrence` and the approved converged tree/digest come in as inputs — take them as parameters.
- `scripts/runAuthorization.ts` — `RunAuthorizationToken` and its digest check.

If a type you want is not in that list, define it locally in `scripts/runConsolidation.ts` as an input parameter. Do not stop and report the task blocked for a missing type.
