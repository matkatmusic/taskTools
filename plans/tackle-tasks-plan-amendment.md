# Amendment to `resilient-jumping-meadow.md`

This amendment addresses the remaining correctness gaps in the proposed `tackle-tasks` repair plan. It should be incorporated before implementation begins.

## Revised guarantees

After these changes:

- A group is eligible to merge only when every applicable task is `done`, its final typecheck passed, its branch contains work, and its actual committed diff stays within the group ownership union.
- Every commit produced by every group, including skipped and conflicted groups, is fetched into a durable ref in the corresponding source repository before eligibility or merge decisions.
- A task changing a nested submodule produces commits through the entire repository chain, deepest submodule through the root parent.
- Merge conflicts discovered during preparation of integration commits do not modify source branches.
- Publication checks recorded source OIDs and restores already-published refs if a later repository cannot be updated.
- Run metadata is available even when preparation fails partway through.
- Shell commands never interpolate repository paths, filenames, or JSON into executable shell source.

Because Git cannot atomically update refs across separate repositories, the cross-repository publication guarantee must be described precisely: integration is prepared without changing source refs; publication uses compare-and-swap; an unexpected partial publication triggers rollback to the recorded source OIDs and reports any rollback failure with recovery commands.

## Amendment 1 — Put run artifacts outside the working tree

Store manifests, task briefs, plans produced for workers, dynamic merge input, and recovery records under:

```text
<git-common-dir>/taskTools/runs/<runId>/
```

Do not write these operational artifacts into `plans/` in the source checkout. This prevents the tool from dirtying the repository immediately after its clean-state preflight and prevents untracked run files from blocking a later checkout or merge.

The human-readable assessment and implementation plans already tracked by the project can remain in `plans/`; only per-run operational files move under the Git common directory.

Create the initial manifest before creating a worktree or branch. Record planned groups and source OIDs first, then update the manifest atomically after each worktree, branch, fetched ref, integration result, publication, or rollback.

Required tests:

- `test_prepareTasksLeavesTheSourceWorkingTreeClean`
- `test_aWorktreeCreationFailureLeavesAReadablePartialRunManifest`
- `test_runArtifactsForTwoRunsUseDifferentDirectories`

## Amendment 2 — Strengthen repository preflight

Dirty-state validation must include tracked, staged, conflicted, and untracked paths. The statement that untracked files cannot block merges must be removed; an untracked path can block a checkout or merge when an incoming commit contains the same path.

Use NUL-delimited porcelain output:

```text
git status --porcelain=v1 -z --untracked-files=all
```

Parse records without splitting on spaces. Handle rename and copy records correctly.

Preflight order:

1. Resolve the Git top-level and Git common directory.
2. Resolve and validate the task-file location and its path base.
3. Reject uninitialized recursive submodules.
4. Inventory the parent and every initialized recursive submodule.
5. Record source branches and source OIDs.
6. Reject detached or dirty repositories.
7. Create the initial manifest.
8. Only then create worktrees and branches.

Required tests:

- `test_dirtyRepositoryPathsReportsAnUntrackedFile`
- `test_preflightReportsEveryDirtyRepository`
- `test_anUntrackedPathThatWouldBeOverwrittenNeverReachesMerge`

## Amendment 3 — Define task roots and canonical ownership identities

The plan must distinguish:

- `repositoryRoot`: the Git top-level used for worktrees and merges.
- `taskRoot`: the directory relative to which the selected task file's declared paths are interpreted.
- `displayPath`: the normalized repository-relative path used in prompts and reports.
- `comparisonIdentity`: the filesystem-aware identity used only for overlap and containment decisions.

If task files are required to live at `<repositoryRoot>/.taskTools/`, enforce that and make `taskRoot` equal to `repositoryRoot`. If nested task files remain supported, explicitly translate their declarations from `taskRoot` to repository-relative paths.

Path validation must:

- Reject absolute paths, empty paths, `.`, and paths escaping the task or repository root.
- Normalize separators and dot segments.
- Determine case sensitivity from the repository/filesystem instead of always lowercasing.
- Resolve symlinks using the nearest existing ancestor.
- Reject a symlink identity that resolves outside the real repository root.
- Preserve the display path separately from the comparison identity.

Directory declarations require a deliberate policy. The recommended policy is to support them, but then brief generation must enumerate or summarize their tracked contents instead of calling `readFileSync` on the directory. A declaration equal to a submodule root means ownership of changes inside that submodule and its gitlink, not an empty path passed to `git add`.

Required tests:

- `test_caseDistinctFilesRemainDistinctOnACaseSensitiveRepository`
- `test_caseAliasesOverlapOnACaseInsensitiveRepository`
- `test_aSymlinkEscapingTheRepositoryIsRejected`
- `test_aMissingFileBelowASymlinkedDirectoryUsesTheResolvedParentIdentity`
- `test_writeTaskBriefFileHandlesADeclaredDirectory`
- `test_aDeclaredSubmoduleRootDoesNotProduceAnEmptyGitPathspec`

## Amendment 4 — Enforce ownership from committed diffs

`git status` after a worker runs is insufficient because a worker can commit undeclared files and leave a clean worktree.

Use two layers of enforcement:

### Task-level enforcement

Before each worker, record the parent and recursive-submodule HEAD OIDs. The controlled commit command receives those expected starting OIDs. Before committing, it must:

1. Refuse unexpected pre-existing ref movement.
2. Inspect both dirty changes and any commits made since the recorded OIDs.
3. Compute NUL-safe changed paths across every repository.
4. Reject every path outside that task's ownership declarations.
5. Commit only through the controlled deepest-first commit routine.

If the worker committed manually, the tool must still detect the changed paths. It may leave those commits preserved for recovery, but the task becomes `blocked` and its group becomes ineligible.

### Group-level enforcement

Before eligibility, compare each fetched group branch with its recorded source OID in the parent and every recursive submodule. Reject the group if any committed path lies outside the group's ownership union. This is the final safety boundary and does not trust agent behavior.

Use `git diff --name-status -z` or an equivalent NUL-delimited command and correctly parse renames, copies, deletions, and submodule gitlinks.

Required tests:

- `test_aWorkerCommittedUndeclaredFileIsDetectedDespiteCleanStatus`
- `test_groupEligibilityRejectsACommittedPathOutsideTheGroupUnion`
- `test_groupOwnershipValidationHandlesRenamesAndSpaces`
- `test_groupOwnershipValidationIncludesSubmoduleCommits`

## Amendment 5 — Propagate nested-submodule commits through all ancestors

When grouping owned paths by repository, expand the repository processing set to include every ancestor repository between an owning repository and the root.

For a path in `outer/inner/file.ts`, the processing set must be:

```text
outer/inner
outer
<parent>
```

Commit sequence:

1. Stage and commit owned changes in `outer/inner`.
2. Stage the `inner` gitlink in `outer`.
3. Commit `outer`, even if it owns no declared file directly.
4. Stage the `outer` gitlink in the parent.
5. Commit the parent.

Skip a repository only when it has neither directly owned changes nor a staged descendant gitlink.

Required tests:

- `test_commitOwnedPathsCommitsEveryAncestorOfANestedSubmodule`
- `test_nestedSubmoduleChangeUpdatesTheRootGitlinkChain`
- `test_nestedSubmoduleCommitLeavesEveryRepositoryClean`

## Amendment 6 — Create durable refs before eligibility

Durability must not depend on whether a group is eligible to merge.

For every prepared group, before evaluating task statuses or typecheck results:

1. Fetch the group branch from every worktree repository into a run-scoped non-source ref in the corresponding source repository.
2. Record the fetched OID in the manifest.
3. Verify the ref resolves to the expected worktree commit.

Use a namespace such as:

```text
refs/taskTools/runs/<runId>/groups/<groupId>/work/<repository-path-hash>
```

Do not rely on a reusable `refs/heads/task-group-*` name as the durable backup. Eligibility can then classify the group as merged, skipped, or conflicted without affecting reachability.

Required tests:

- `test_aBlockedGroupHasDurableRefsInEveryRepository`
- `test_aPartialSubmoduleCommitIsReachableFromTheSourceRepository`
- `test_eligibilityDoesNotModifyAnySourceBranch`

## Amendment 7 — Prepare integration commits before publication

Rename Phase 3c from “transactional merging” to “integration preparation and recoverable publication” unless full rollback is implemented.

### Integration preparation

For each eligible group:

1. Start from recorded source OIDs, not movable branch names.
2. Create temporary integration refs or temporary integration worktrees in every repository.
3. Merge deepest-first without changing source branches.
4. Materialize actual merge commits, including the resolved gitlink chain.
5. Record every integration commit OID in the manifest.
6. If any repository conflicts, delete nothing, classify the group as conflicted, and leave all source refs unchanged.

`git merge-tree --write-tree` may be used as part of this process, but its output format must be explicit. Use `-z` and `--no-messages`, and parse the documented NUL-delimited records. Do not treat arbitrary stdout lines as paths.

### Recoverable publication

Publish only after all integration commits exist:

1. Re-read every source ref and require it to equal the manifest's recorded source OID.
2. Update each source ref with compare-and-swap semantics using its expected old OID.
3. Record each successful update immediately.
4. If a later update fails, restore already-updated refs to their recorded OIDs using compare-and-swap against the integration OIDs.
5. If rollback fails, stop, preserve all refs and worktrees, and emit exact manual recovery commands.
6. Update checked-out source worktrees only after ref publication succeeds, and report any worktree-refresh failure separately from ref publication.

Do not claim true atomicity across repositories. Claim conflict-free preparation plus checked, recoverable publication.

Required tests:

- `test_aConflictDuringIntegrationLeavesEverySourceRefUnchanged`
- `test_aSourceRefRacePreventsPublication`
- `test_aLaterPublicationFailureRollsBackEarlierSourceRefs`
- `test_aRollbackFailurePreservesRecoveryRefsAndInstructions`
- `test_mergeTreeParsingIgnoresTreeIdsAndInformationalMessages`

## Amendment 8 — Remove shell interpolation boundaries

Passing paths through `JSON.stringify` and placing them in double-quoted shell text does not prevent command substitution. Paths containing `$()`, backticks, or variable syntax remain executable shell input.

Operational data must be passed through files under the run directory or through a structured execution API that accepts an executable plus an argument array.

Recommended merge-agent command:

```text
node --no-inspect <fixed-merge-script-path> <fixed-run-input-path>
```

The run-input file contains the manifest path, task outcomes, typecheck outcomes, and metrics. No user-controlled repository path, task path, commit message, or JSON is embedded in shell source.

Use a fixed commit message derived only from the validated integer task number, or place the message in the input file. The commit helper likewise receives one run-controlled input-file path.

Required tests:

- `test_mergeInvocationHandlesAPathContainingCommandSubstitutionSyntax`
- `test_commitInvocationHandlesADeclaredPathContainingBackticks`
- `test_cliInputFilesRoundTripSpacesApostrophesAndDollarSigns`

## Amendment 9 — Test the workflow itself

The preparation/merge CLI end-to-end tests do not exercise the workflow's planner, partial retry, outcome aggregation, or merge-result schema.

Add a workflow harness that evaluates `tackle-tasks.workflow.js` with injected implementations of:

- `args`
- `agent`
- `parallel`
- `pipeline`
- `log`

The harness should deterministically return planner, worker, retry, and typecheck results. If direct evaluation is impractical, move result normalization into a pure tested module and add a small source-contract test proving the workflow calls it.

Update `MERGE_SCHEMA` to require `merged`, `conflicts`, and `skipped`.

Required tests:

- `test_aNullPartialRetryBecomesBlockedWithoutCrashing`
- `test_aWorkerResultForTheWrongTaskIsRejected`
- `test_duplicatePlannerResultsDoNotOverwriteAnotherTask`
- `test_aFailedTypecheckProducesASkippedGroup`
- `test_workflowReturnsSkippedMergeResults`

## Amendment 10 — Complete interface and recovery reporting

Every merge result must include:

- `runId`
- `groupId`
- `taskNumbers`
- classification: `merged`, `skipped`, or `conflicted`
- reason
- source OIDs
- integration OIDs, when created
- durable ref names
- worktree path
- conflicted paths by repository
- publication and rollback state

`close-tasks` receives only the union of task numbers from results classified as `merged` after publication succeeded. It must never infer task numbers from group IDs.

The user-facing report must name preserved worktrees and durable refs for every skipped or conflicted group, plus recovery instructions when publication or rollback was incomplete.

## Revised phase order

1. **Test harness:** add the working package scripts and workflow harness.
2. **Root and preflight:** establish repository root, task root, complete repository inventory, dirty-state policy, and initial manifest.
3. **Run isolation:** create run-scoped worktrees and branches while updating the manifest incrementally.
4. **Canonical ownership:** implement filesystem-aware path identities and directory policy.
5. **Controlled commits:** enforce pre-worker refs, actual committed diffs, and nested-submodule ancestor propagation.
6. **Durability:** fetch every group repository into run-scoped durable refs before eligibility.
7. **Eligibility:** require complete task outcomes, passed typecheck, parent work, and clean group-level ownership validation.
8. **Integration preparation:** build all repository merge commits without modifying source refs.
9. **Recoverable publication:** compare-and-swap source refs, rollback on failure, and refresh source worktrees.
10. **Lifecycle:** return task-level results and close only successfully published tasks after approval.

No phase should be called complete until its new tests pass along with the full existing suite and typecheck.
