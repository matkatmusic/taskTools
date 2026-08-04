# Phase 3 — Parallel Run Consolidation

## Summary

Make file-disjoint task groups safe in the recursive/repeated-repository model. Group tasks using their logical effects, then consolidate every group's work into one operation history and one prepared integration OID per logical repository. Preserve the required separation between child-gitlink commits and repository-own changes. Base publication remains disabled until Phase 4.

## Implementation

- Complete repository identity discovery before final task grouping and worktree creation.
- Convert every declared task path into canonical ownership keys consisting of logical repository ID plus path within that repository. Expand its effects to synchronized occurrence paths and affected ancestor gitlinks.
- Union tasks when canonical ownership/effect paths overlap. Tasks naming the same logical file through different occurrences must serialize; disjoint files may remain in parallel groups even when they belong to the same logical repository.
- Replace commit-based worker ownership checks with before/after recursive snapshots covering tracked, untracked, deleted, renamed, mode, and symlink states. Attribute each worker delta to its declared ownership and retain the group boundary as the final check.
- Build post-approval finalization as a pure, authorization-requiring subsystem, but do not connect production approval or publication until Phase 4:
  1. Finalize logical children first using explicit occurrence edges.
  2. In each participating group/occurrence branch, create a nonempty commit for approved own-file changes only; exclude child gitlinks.
  3. Preserve each tip under a run-scoped durable ref.
  4. Create one temporary assembly branch at the logical repository's recorded base.
  5. Set every direct child occurrence to its finalized integration OID and create one distinct gitlink-bump commit per changed parent gitlink, ordered by path within the immediate parent.
  6. Fetch and merge every participating group/occurrence branch with `--no-ff`, ordered by group ID and occurrence path.
  7. Verify the resulting projected tree equals the approved converged tree plus the finalized child gitlinks.
  8. Name the result as the run-level operation branch in the canonical occurrence and fast-forward every participating occurrence branch to its OID.
  9. Prepare one real `--no-ff` integration merge from recorded base to operation tip without moving `baseBranch`.
- For repeated repositories, select `lastWriterOccurrence` as canonical while retaining its path-suffixed branch name. All occurrence and group tips must remain ancestors of the canonical operation OID.
- If any merge conflicts or produces an unapproved tree, preserve all refs, return repository-qualified conflicts, and require testing and approval to be renewed in Phase 4.
- Produce one prepared integration OID per logical repository across the whole run. Never prepare competing base updates per task group.
- Keep remote pushes, base-ref updates, and task archival disabled. Continue using the existing production workflow until Phase 4 performs the cutover.

## Interfaces

- Task grouping accepts the occurrence graph and logical-repository map in addition to task paths.
- Ownership snapshots expose repository/occurrence-qualified deltas instead of commit ranges.
- Finalization requires an opaque authorization input; tests may construct it, but only Phase 4's approval recorder may issue it in production.
- Consolidation returns occurrence commits, durable refs, canonical operation OIDs, prepared integration OIDs, and conflicts without updating base refs.

## Tests and Acceptance

- Verify alias paths for the same logical file force one serial group.
- Verify synchronization and ancestor-gitlink effects participate in overlap detection.
- Verify disjoint files in one logical repository remain parallel and both group tips become ancestors of one run-level operation branch.
- Verify one own-files commit contains no gitlink changes.
- Verify one separate bump commit is created per changed direct child occurrence and no empty commits are created.
- Verify a parent containing multiple occurrences of one logical child updates every gitlink to the same child integration OID.
- Verify nested child OIDs propagate through each correct explicit parent edge to the root.
- Verify conflicts leave every base ref unchanged and preserve all occurrence/group tips.
- Phase 3 is complete when arbitrary parallel group histories can be deterministically consolidated into one verified operation and integration OID per logical repository without publishing anything.
