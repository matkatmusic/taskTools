# Phase 4 — Approval, Durability, and Publication

## Summary

Activate the recursive workflow behind a whole-run human approval gate. Preserve all pre-approval work recoverably, validate that the approved state has not changed, run the Phase 3 finalizer deepest-first, push only canonical repeated-repository operation branches, publish local base refs atomically, and archive only successfully merged tasks.

## Implementation

- Restructure startup so command interpolation performs only read-only task and blocker discovery. Before creating worktrees or branches, require confirmation that the copied taskTools test hook is enabled.
- Allow an explicit per-run hook-disabled override. Record it in the manifest and require complete suites in every affected repository and parent immediately before approval.
- Do not create semantic commits, remote pushes, integration merges, base updates, or task archival before approval.
- Preserve work after each worker and N-way synchronization using internal run-scoped recovery refs. Build recovery snapshots with temporary indexes and recursive gitlink substitution without moving operation or base branches.
- Require every selected task to be `done`, ownership checks and typechecks to pass, repeated occurrences to converge, final test receipts to be green, and each group to provide an exercise method before setting `readyForApproval`.
- Have a report-only reviewer return at least one actionable method per group: a live server URL or an exact command plus working directory. Partial, blocked, clarification, ownership, typecheck, sync, test, or missing-review results keep the run recoverable but not approvable.
- Present one approval gate for the entire run and record approval against a digest of the manifest, files, operation/base refs, occurrence digests, test receipts, and review handoffs. Any later drift invalidates approval and returns the run to review.
- After approval, invoke the Phase 3 finalizer recursively and deepest-first. The authorization token must be issued only by the approval recorder and match the current digest.
- For each repeated logical repository:
  - Push only its canonical run-level operation branch, after approval and without force.
  - Require an existing remote branch tip to be an ancestor or abort before base publication.
  - Fetch the canonical branch into every other occurrence and verify it is already at the same OID and tree.
- Do not push unique operation branches or any base branch automatically.
- Publish only after the root integration OID exists:
  - Revalidate all recorded base OIDs and approval inputs.
  - Update one canonical local base ref per logical repository using compare-and-swap semantics.
  - Align other local occurrences' base branches through local fetch and fast-forward.
  - If any update fails, roll back already updated refs to their recorded OIDs.
  - Preserve integration/recovery refs and report exact recovery commands if publication or rollback is incomplete.
- Return task-level merge results after successful publication and archive only the explicit successfully published task numbers. The whole-run approval authorizes finalization and archival; do not add a second post-merge approval.
- Activate the new manifest/workflow version only after the complete end-to-end suite passes. Preserve legacy worktrees and route legacy manifests to their existing compatible tooling or a non-destructive refusal.

## Interfaces

- Workflow preparation returns recursive graph metadata, hook mode, recovery refs, test receipts, review handoffs, and `readyForApproval` instead of immediate merge results.
- Approval recording returns an opaque authorization tied to the complete state digest.
- Finalization returns merged, conflicted, skipped, publication, rollback, and recovery results per logical repository and task.
- Run manifests persist approval state, occurrence and group commits, canonical operation OIDs, integration OIDs, pushes, base publication attempts, rollback results, and archival eligibility.

## Tests and Acceptance

- Verify no semantic commit, push, integration merge, base mutation, or archival occurs before approval.
- Verify hook confirmation precedes every mutating preparation step.
- Verify the disabled-hook override runs all affected suites and is recorded.
- Verify partial, blocked, failed, or missing-review results cannot become `readyForApproval`.
- Verify any post-approval file, ref, digest, or receipt change invalidates authorization.
- Verify operation pushes occur only for repeated repositories, only after approval, and never force-update a remote branch.
- Verify base races prevent publication, partial publication rolls back, and rollback failure preserves exact recovery refs and commands.
- Run a RevEng-shaped end-to-end fixture containing:
  - `tmux_lib` at `tmux_lib`, `jfred/external/tmux_lib`, and `jfred/jfredToolsPlugin/external/tmux_lib`.
  - Two occurrences each of `claude_plugin_lib` and `scenarios`.
  - Nested submodules beneath ordinary directories and distinct parent chains.
- In that fixture, verify a change from any repeated occurrence converges everywhere, all child and ancestor suites pass, approval precedes commits/merges/pushes, all occurrence histories consolidate, gitlinks propagate through the correct parents, and every intended local base ends at the expected merge commit.
- Phase 4 is complete when the recursive workflow is the production path, finishes the RevEng-shaped run without data loss, and archives only tasks whose integration was successfully published.
