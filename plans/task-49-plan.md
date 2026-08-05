# Task 49 plan: connect `mergeTaskWorktrees` to finalization and publication

## Goal and fixed constraints

Replace only the `runAsCli` pipeline path in `scripts/mergeTaskWorktrees.ts`. The
`--discover` and `--merge` modes, and the exported
`mergeGroupBranchIntoRepo`, `mergeSubmoduleBranchIntoRepo`,
`resolveGitlinkConflicts`, and `removeWorktreeAndBranch` functions, remain
behaviorally unchanged.

The default CLI continues to accept the existing flat JSON object in `argv[2]`;
`--run <arguments-file> [outcomes-file]` continues to merge those two flat
objects. Stdout retains these exact top-level fields:

```ts
{
    merged,
    conflicts,
    testReceipts,
    reviewHandoffs,
    occurrenceDigests,
    runState,
    publicationTargets,
}
```

Implementation edits are limited to:

- `scripts/mergeTaskWorktrees.ts`
- `scripts/mergePipeline.ts` (new)
- `tests/mergeTaskWorktrees.test.ts`

The five pipeline modules named in task 49 are read-only. Both production
files must finish below the repository's 250-line cap.

## HISTORICAL — mistakes in a SUPERSEDED earlier draft, all already corrected below

> Read this before acting on it: this section is a post-mortem of an OLD draft that no longer
> exists. It is NOT a statement about this plan, and it is NOT a reason to stop. Every item below
> is already fixed in the design that follows. This plan IS implementable and has in fact been
> implemented — see worktree commit `d5580e1`. Never report task 49 as blocked on the strength of
> this section.


The previous draft contained complete proposed source, but it was based on
several false assumptions. Do not reuse that source verbatim.

1. **Manifest paths were treated as root-relative.** Real manifests from
   `repositoryDiscovery.ts` contain absolute `checkoutPath` values. Only the
   hand-written fixtures in `mergeTaskWorktrees.test.ts` use `""` and
   `"vendor"`. Calling `join(input.repo, occurrence.checkoutPath)` therefore
   produces the wrong production path. The adapter must explicitly support both
   shapes and must derive a root-relative occurrence path for each group
   worktree.

2. **`operationBranch` was assumed to be populated.** The production bootstrap
   is read-only and leaves new occurrences' `operationBranch` as `""`.
   Supplying that to `runConsolidation` creates an invalid ref ending in `/`,
   and supplying it to `operationPush` makes `rev-parse` fail. The operation
   branch used for pushing must come from the successful consolidation result,
   not from the input manifest.

3. **Consolidation was incorrectly performed once per occurrence.**
   `runConsolidation.ts` consolidates one *logical repository*: every group
   branch from every occurrence sharing an upstream identity belongs in the
   same input. The old draft grouped occurrences only for pushing and therefore
   never converged repeated occurrences.

4. **The refs expected by `runConsolidation` did not exist.** It derives each
   participating ref as `refs/heads/${groupId}/${occurrencePath}` and updates it
   with compare-and-swap. Current worktrees instead have branches such as
   `task-group-1` in separate repositories. The adapter must create run-scoped,
   ref-safe tracking refs in the canonical repository before calling
   `consolidateRun`.

5. **The branch pushed by `operationPush` was unrelated to consolidation.**
   The draft created `refs/heads/operations/...` but passed the manifest's old
   `operationBranch` to `pushOperationBranches`. The push input must use the
   short branch name returned in `RunConsolidationSuccess.operationBranchRef`.

6. **Semantic merge commits were created before approval.**
   `prepareNoFfMerge` calls `commit-tree`; it is ref-pure, but it still creates
   a semantic commit. Calling it while deciding `readyForApproval` violates the
   approval boundary. Pre-approval conflict checks may use `git merge-tree
   --write-tree`, but `prepareNoFfMerge`, finalizer refs, consolidation refs,
   pushes, base changes, and archival all stay after authorization.

7. **Finalizer output was disconnected from consolidation.** The draft ran the
   finalizer on an already folded commit, then made consolidation fold the raw
   group tips instead. That does not make every group/occurrence history an
   ancestor of the actual published result and loses finalizer gitlink work.

8. **`finalizedChildGitlinks: []` was justified for the wrong reason.** It is
   valid only when each participating parent tip has already had its finalized
   child OIDs installed by `runFinalizer`. It is not valid as a way to ignore
   child propagation. Logical repositories must be processed child-first so a
   parent's finalizer inputs can use each child's consolidated integration OID.

9. **Publication was incorrectly built per occurrence.**
   `basePublication.PublicationTarget` represents one logical repository: one
   canonical occurrence plus `otherOccurrences`. Publishing separately per
   occurrence defeats its rollback/alignment behavior. The stdout summary may
   still list every occurrence, but `publishBases` receives one target per
   logical repository.

10. **The proposed publication target ignored `preparedIntegrationOid`.** The
    finalizer produces finalized participating tips; consolidation produces the
    one operation OID and the one base-integrated OID for a logical repository.
    The latter is what the base branch must publish. Publishing a per-occurrence
    finalizer tip bypasses the required base integration.

11. **Run inputs were deleted too early.** A conflict-free preflight is not a
    completed run. The three `.taskTools/run-*.json` files must remain available
    after missing approval evidence, finalization/consolidation failure, push
    failure, or publication rollback. Remove them only after successful base
    publication and archival processing.

12. **The proposed new test repeated the artificial fixture shape.** It used
    relative checkout paths and pre-filled operation branches, so it could not
    catch failures 1 or 2. The required end-to-end test must use the real
    bootstrap manifest shape.

## Design for `scripts/mergePipeline.ts`

Keep this module as the translation/orchestration layer. Do not copy git merge,
push, publication, or archival algorithms out of their owner modules.

### 1. Input and path normalization

Move `CliInput` and the stdout-only publication summary type from
`mergeTaskWorktrees.ts` into this module.

At entry:

1. Require a manifest and validate it with `validateRepositoryManifest`.
2. Require exactly one root occurrence and at least one group.
3. Generate a ref-safe default run ID (`merge-${Date.now()}-${process.pid}`)
   when the input has none, and validate a representative ref using
   `git check-ref-format` before any mutation.
4. For each occurrence, compute:
   - `repoRoot`: use `checkoutPath` directly when it is absolute; otherwise
     resolve it under `input.repo` for backward-compatible tests.
   - `relativePath`: `relative(resolve(input.repo), repoRoot)`, normalized to
     `""` for the root. Reject paths outside `input.repo`.
   - `groupRepoRoot`: `relativePath === "" ? group.worktree :
     join(group.worktree, relativePath)`.
5. Key maps by `occurrenceId`, never by `checkoutPath`; paths can differ in
   representation while occurrence IDs are the graph identity.

This preserves compatibility with existing fixtures while using the absolute
coordinate system selected by task 52 in production.

### 2. Build logical repositories and participating tips

Construct the logical-repository overlay before preflight:

- For parseable origins, use the same normalized identity semantics as
  `buildLogicalRepositories`/`normalizeRepositoryIdentity`.
- Treat equal, non-empty opaque origins (notably the discovery fallback
  `rootcommit:<oid>`) as the same logical repository.
- Treat blank origins in old test fixtures as distinct singleton repositories;
  do not accidentally group every `originUrl: ""` fixture together.
- Preserve deterministic manifest order for canonical/selected occurrence
  choice and for output.

For every `(group, occurrence)` pair, read the group occurrence's current HEAD
OID from `groupRepoRoot`. Retain the group ID, source repo root, occurrence ID,
and normalized relative path. These are the approved raw tips.

Repeated logical repositories are supported only when all their occurrences
record the same `baseOid`. `basePublication.ts` has only one
`recordedBaseOid` per logical target and uses that value during rollback of
other occurrences; allowing unequal bases would make rollback incorrect.
Report unequal bases as a non-mutating conflict before approval.

### 3. Pre-approval checks and approval digest

Preflight must create no commit and move no ref.

For each raw group-occurrence tip, run `git merge-tree --write-tree
<occurrence.baseOid> <tipOid>` in that group occurrence repository. Capture
repository-qualified conflicted paths on failure. This detects the existing
single-group/base-divergence regression without calling `prepareNoFfMerge`.
Cross-group folding remains authoritative in `consolidateRun`; prior workflow
convergence should make that fold clean, but an unexpected post-approval abort
must still be reported and must stop push/publication.

Build the existing per-group `MergeOutcome` arrays from this preflight. A
failed occurrence marks its group conflicted and populates root conflicts or
`submoduleConflicts` according to the occurrence's relative path.

When every preflight succeeds, calculate:

- occurrence snapshots from each raw tip's `ls-tree -r -z` output;
- `files`, `testReceipts`, and `reviewHandoffs` exactly as today;
- a deterministic pending-operation fingerprint from the ordered
  `(groupId, occurrenceId, tipOid)` tuples for `digestInput.operationRef`;
- `readyForApproval` using the current CLI contract: all preflights clean, at
  least one test receipt, every receipt green, and at least one review handoff.

Create `RunState`. If not ready, print the normal stdout object, write metrics,
and return without finalizer, consolidation, push, publication, archival, ref
creation, or input cleanup. If ready, call `recordApproval` then
`issueApprovalAuthorization` once. All following adapter-owned git mutations
must also be enclosed by `runFinalization(token, approvalDigest, ...)`.

### 4. Finalize and consolidate child-first

Topologically order logical repositories from deepest children to root using
the manifest's explicit `childOccurrenceIds`. Reject a logical dependency
cycle instead of partially mutating the run.

For each logical repository in that order:

1. For each participating `(group, occurrence)` raw tip, call
   `finalizeApprovedRun` with a small finalization graph:
   - the parent input uses the raw tip for both `currentTipOid` and
     `recordedBaseOid`, with `approvedOwnFileChanges: []` because worker
     changes are already committed;
   - each direct child edge points to a proxy child input whose current/base
     OID is that child logical repository's already-consolidated
     `preparedIntegrationOid`;
   - IDs and per-call run IDs are deterministic, ref-safe adapter IDs, not raw
     filesystem paths.

   This makes the returned parent `finalizedIntegrationOid` retain that
   group's own commits while substituting every direct child to the exact OID
   that will be published for the child.

2. In the canonical occurrence repository, fetch every finalized participating
   OID and create a unique run-scoped tracking ref. Shape the
   `GroupOccurrenceBranch.groupId` and `.occurrencePath` so
   `runConsolidation`'s private formula
   `refs/heads/${groupId}/${occurrencePath}` names that exact tracking ref.
   Use padded group numbers and a hash/sanitized occurrence segment so ordering
   and ref validity do not depend on path punctuation. Create these refs only
   inside the authorization wrapper.

3. After authorization, fold the same sorted participating OIDs with
   `prepareNoFfMerge` solely to obtain the approved converged tree OID for the
   consolidation input. This may create unreachable temporary commits, but it
   occurs after approval and moves no ref.

4. Call `consolidateRun(runId, [input], token, digest)` with:
   - one input for the whole logical repository;
   - the canonical occurrence repo and canonical occurrence's recorded base;
   - all finalized group/occurrence tips;
   - the computed converged tree;
   - `finalizedChildGitlinks: []`, because step 1 already installed them in
     every participating parent tip;
   - a deterministic ref-safe canonical branch suffix, independent of the
     manifest's possibly-empty `operationBranch`;
   - the canonical base branch ref only as preservation metadata.

5. On abort, convert the repository-qualified result to the existing
   `conflicts` output, clear `merged`, preserve all recovery/finalizer/operation
   refs, write metrics, and return. Do not push, publish, archive, or clean up.

6. On success, retain all three distinct values:
   - `operationBranchRef`/`operationOid` for remote operation push;
   - `preparedIntegrationOid` for local base publication;
   - a durable adapter-created
     `refs/finalize/${runId}/integration/<safe-logical-id>` at the prepared
     integration OID, used as the root-integration existence proof.

Never substitute a finalizer tip for `preparedIntegrationOid`.

### 5. Push operation branches

After every logical repository consolidates successfully, build the
`OperationPushInput`:

- use absolute occurrence checkout paths;
- reuse the logical grouping/canonical selection from step 2;
- set each logical repository's occurrences' `operationBranch` to the short
  branch name obtained by removing `refs/heads/` from that repository's
  successful `operationBranchRef`.

Call `pushOperationBranches` exactly once. Unique repositories are skipped by
that module; repeated repositories push only their canonical operation branch.
Any push/verification error exits nonzero before base publication or archival;
the CLI catch writes the error to stderr, and `runMergePhase.ts` already turns a
nonzero exit into a blocked result.

### 6. Publish bases and archive tasks

Immediately before publication, verify every occurrence's real base ref still
equals its recorded `baseOid`. This closes the gap in `publishBases`, which
prevalidates canonical refs but not `otherOccurrences`. A mismatch returns a
blocked/conflict stdout result without calling publication.

Build one `basePublication.PublicationTarget` per logical repository:

- canonical path/ref from its canonical occurrence;
- `otherOccurrences` from every remaining occurrence's path/ref;
- common recorded base OID;
- `targetOid: preparedIntegrationOid`.

Order targets child-first, call `publishBases` once, and pass the durable root
integration ref created in step 4. Build stdout `publicationTargets` in manifest
occurrence order so the public shape stays familiar; repeated occurrences may
share the same target OID.

If publication returns `published: false`, do not archive. Convert the failure
to existing `MergeOutcome` conflict/failure fields so `runMergePhase.ts` cannot
mistake a rolled-back run for success. Preserve all durable refs and input files
for recovery.

If publication succeeds:

1. Build one published repo outcome per `(task, logical repository)` using the
   corresponding prepared integration OID.
2. Call `summarizeTaskMergeResults` and then `archivePublishedTasks` with the
   explicit selected task numbers. No task is eligible unless the whole
   logical-repository set published.
3. Remove only `run-arguments.json`, `run-outcomes.json`, and `run-steps.json`.

Metrics remain written on every normal JSON-return path. Their conflict count
must reflect preflight, consolidation, base-race, or publication failure rather
than only legacy merge conflicts.

## Changes to `scripts/mergeTaskWorktrees.ts`

1. Keep all code through `runMergeCli` unchanged.
2. Remove the local `CliInput`, local `PublicationTarget`, pipeline-only
   imports, and the entire current `runPipelineCli` function.
3. Import `runMergePipeline` from `./mergePipeline.ts`.
4. Make only `runAsCli` async. Preserve `--discover` and `--merge`; await
   `runMergePipeline` for `--run` and default JSON modes.
5. Add one terminal `.catch(...)` that prints the stack/message to stderr and
   sets `process.exitCode = 1`.

The type-only import from `mergePipeline.ts` back to `MergeOutcome` and
`SubmoduleConflict` is erased at runtime, so it does not create a runtime cycle.
After extraction, `mergeTaskWorktrees.ts` should be about 240 lines.

## Test changes

Keep all 15 existing tests and their CLI assertions unchanged. In particular,
the green-evidence test may continue asserting that base refs move by process
exit: they now move only in `publishBases`, not during preflight/consolidation.

Add these tests to `tests/mergeTaskWorktrees.test.ts`:

1. **No evidence causes no finalization mutation.** Run a clean group without
   receipts/handoffs. Assert `readyForApproval === false`, both base OID and
   branch remain unchanged, and no `refs/finalize/`, `refs/heads/operations/`,
   or input tracking refs exist.

2. **Production-shaped nested finalization succeeds.** Build a temporary root
   repository with a local submodule, obtain the manifest through
   `bootstrapRepositoryManifest` (therefore absolute checkout paths and empty
   operation branches), make root and child commits in one group worktree, and
   run the flat argv CLI with green evidence. Assert:
   - stdout has exactly the seven existing top-level fields;
   - root and child base refs equal their publication targets;
   - each target descends from both its recorded base and participating group
     tip;
   - the published root gitlink equals the published child target;
   - finalizer, operation, and durable integration refs exist;
   - the worktree and original group branch remain available.

3. **Repeated occurrences consolidate and publish once logically.** Build a
   root with two checked-out submodule occurrences backed by the same local bare
   remote, commit distinct changes through the participating group occurrences,
   and run with green evidence. Assert one canonical operation branch is pushed,
   both histories are ancestors of its OID, both local base occurrences align to
   the same prepared integration OID, and both parent gitlinks point to that
   exact OID. This catches per-occurrence consolidation and wrong-push-ref
   regressions.

4. **Successful publication archives; failure does not.** In isolated temp
   project task files, give a group one real task record. On success assert it
   moves to completed tasks with published commit hashes. In a second run force
   a base race before publication (or use a repeated occurrence whose base ref
   no longer matches), assert the task remains open and the three run input
   files remain for recovery.

Do not weaken the existing conflict test: its divergent source branch must
still produce `readyForApproval: false`, no approval/authorization, and no
publication target.

## Verification

Run, in order:

```sh
node --test tests/mergeTaskWorktrees.test.ts
node --test tests/runFinalizer.test.ts tests/runConsolidation.test.ts tests/operationPush.test.ts tests/basePublication.test.ts tests/taskArchival.test.ts
npx tsc --noEmit
wc -l scripts/mergeTaskWorktrees.ts scripts/mergePipeline.ts
node --test tests/
```

Acceptance criteria:

- all pre-existing merge-worktree tests pass without rewritten assertions;
- the new absolute-path/empty-operation-branch fixture passes end to end;
- repeated occurrences produce one logical operation/integration result;
- no finalization/push/publication/archive mutation occurs without approval;
- only `publishBases` moves real base refs;
- only successfully published tasks are archived;
- both production files are below 250 lines;
- the complete test suite and typecheck are green.
