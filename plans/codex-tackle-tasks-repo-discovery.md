 # Recursive First-Class Submodule Worktree Strategy

  ## Summary

  Implement this design on top of the completed resilient-jumping-meadow
  branch.

  Replace the current flat “parent plus submodule paths” model with a
  recursive repository occurrence graph overlaid with logical-repository
  equivalence classes. Every logical repository receives its own
  recorded base branch/OID, operation branch, tests, commits, integration
  merge, and publication result. Repeated occurrences of one upstream
  repository synchronize code, retain occurrence-specific branches,
  consolidate their histories, and ultimately share one exact commit.

  The workflow becomes two-phase:

  1. Prepare, edit, synchronize, test, and produce a whole-run human-
     review handoff without semantic commits, remote pushes, or base-
     branch changes.

  2. After explicit approval, commit and integrate deepest-first, push
     only canonical repeated-repository operation branches, and publish
     base refs recoverably.

  ## Implementation Changes

  ### 1. Repository discovery and setup

  - Replace RepositorySource[] with a recursive manifest graph:
      - RepositoryOccurrence: stable occurrence ID, root-relative path,
        parent occurrence ID, path within the immediate parent, depth,
        recorded gitlink OID, normalized origin URL, logical repository
        ID, base branch/OID, operation branch, children, and test state.

      - LogicalRepository: normalized origin identity, an arbitrary-size
        set of occurrence paths,
        selected base, canonical occurrence, last-writer occurrence, and
        consolidation state.

  - Keep occurrence parentage separate from logical identity. The
    occurrence graph remains a rooted tree even when three or more nodes
    refer to one logical repository; equivalence classes coordinate their
    content and histories but never collapse their distinct parent chains.

  - Represent direct parent/child relationships explicitly with
    occurrence IDs and each child's path within its immediate parent.
    Replace every use of string dirname or slash-count inference for
    finding a parent repository, child gitlink name, or traversal depth.
    For example, the parent of
    jfred/jfredToolsPlugin/external/tmux_lib is the
    jfred/jfredToolsPlugin repository occurrence, not the filesystem
    directory jfred/jfredToolsPlugin/external. This specifically replaces
    the existing nested-gitlink logic in owned-path committing and
    integration preparation, which derives a parent by removing only the
    final path segment and therefore cannot model RevEng's layout.

  - Resolve logical identity from normalized, fully resolved .gitmodules
    URLs:
      - Resolve relative URLs against the parent repository’s origin.
      - Normalize equivalent SSH/HTTPS/scp syntax to host/owner/repository
        identity.

      - If URLs differ or are unavailable, pause and ask the user whether
        occurrences are equivalent.

  - Traverse root outward in preorder:
      1. Record the root’s current branch and OID as its base.
      2. Initialize each direct child at the gitlink OID recorded by its
         parent, without recursively initializing everything at once.

      3. Fetch remote branch refs and find branches whose tip exactly
         equals that OID.

      4. If exactly one branch matches, record it as baseBranch; if zero
         or multiple match, return a resolution request and ask the user.

      5. Create and check out the run-scoped operation branch at the
         recorded OID.

      6. Recurse into that child’s own direct submodules.

  - If repeated occurrences resolve to different recorded commits or base
    branches, pause and ask the user to select the reconciliation source
    before editing begins.

  - Unique repositories use the group's run-scoped operation branch
    unchanged. Repeated occurrences append a sanitized full root-relative
    path slug plus a short collision hash, for example:
      - task-group-<run>-<group>--tmux-lib
      - task-group-<run>-<group>--jfred-external-tmux-lib
      - task-group-<run>-<group>--jfred-jfredtoolsplugin-external-tmux-lib

  - Persist discovery questions and answers in the run manifest so setup
    can resume without repeating resolved questions.

  - Complete repository identity discovery before final task grouping and
    worktree creation. Extend each declared task path into canonical
    ownership keys consisting of logical repository ID plus path within
    that repository. Include every synchronized occurrence and affected
    ancestor gitlink in the task's effect set. Union tasks when any
    canonical ownership/effect paths overlap, so two tasks cannot run in
    separate groups when duplicate synchronization would make them touch
    the same effective file. Tasks changing disjoint files may remain in
    separate parallel groups, including when those files belong to the
    same logical repository; finalization combines their branches through
    the run-level integration chain described below.

  - Treat manifests from the older flat repository model as incompatible;
    preserve their worktrees but refuse to finalize them with the new
    code.

  ### 2. Auto-testing and pre-approval synchronization

  - Copy Jot’s related-test hook into taskTools; do not modify Jot.
  - Register the copied hook as taskTools’ PostToolBatch hook and enable
    its main() entry point.

  - Enhance ordinary edit handling to resolve the nearest Git root for
    each edited file, batch by owning repository, and look for matching
    tests in that repository’s tests/ directory rather than always using
    the session root.

  - Add a sync-receipt CLI mode to the copied hook. A receipt identifies:
      - Logical repository and run.
      - Source occurrence and all destination occurrences.
      - Added, modified, renamed, and deleted paths.
      - Expected occurrence branches.
      - Immediate parent chain for each occurrence.

  - Record an explicit test policy for every repository occurrence:
      - Related-test resolution used after ordinary source-file edits.
      - A complete repository-suite command used when that repository is
        an affected parent, because a child gitlink change cannot safely
        be validated by filename matching alone.

      - Resolve commands from repository configuration when unambiguous;
        otherwise emit a setup resolution request before workers start.

  - In sync-receipt mode, the hook must:
      1. Verify expected branches.
      2. Verify synchronized code trees are byte-, mode-, symlink-,
         rename-, and deletion-equivalent.

      3. Exclude .git, ignored build output, and nested submodule contents
         handled as separate logical repositories.

      4. Run matching tests in every occurrence with that occurrence as
         cwd.

      5. Run the configured complete suite in every affected immediate
         parent with that parent as cwd; repeat while walking outward.

      6. Fail on missing matching tests, mismatched trees, or test
         failures.

      7. Write a green receipt containing content digests and test
         results.

  - Change tackle-tasks startup ordering:
      - Keep only read-only task/blocker discovery in command
        interpolation.

      - Before creating worktrees or branches, ask the user to confirm the
        taskTools auto-test hook is enabled.

      - Allow an explicit per-run “proceed with hook disabled” override
        and record it in the manifest.

      - Under the override, run complete suites once in every affected
        repository and parent after convergence and before presenting
        human approval.

  - During implementation, repeated repositories use deterministic N-way
    file-
    only synchronization:
      - Derive changes relative to the occurrence’s recorded base,
        including untracked files, modes, symlinks, renames, and
        deletions.

      - Copy code changes only; never copy .git, build output, or nested
        submodule directories.

      - Fan every accepted change out from its source to all other
        occurrences, not just one paired destination. A fix may originate
        in any occurrence; record it as
        lastWriterOccurrence.

      - After every synchronization, invoke the copied hook in sync-
        receipt mode.

      - Continue until all occurrences in the equivalence class have the
        same digest and all occurrence and distinct parent-chain tests are
        green for that digest. Deduplicate identical repository/test/digest
        executions, but do not skip different parents merely because they
        contain the same logical child.

  - Workers do not create semantic Git commits before approval. Preserve
    work after each worker/synchronization with internal recovery commits
    under run-scoped refs, built using temporary indexes and recursive
    gitlink substitution without moving operation or base branches.

  - Replace commit-based task ownership checks with before/after
    repository snapshots:
      - Hash tracked, untracked, deleted, renamed, mode-changed, and
        symlink states across the recursive graph.

      - Attribute the delta introduced by each worker to that task’s
        ownership.

      - Keep the group-level ownership validation as the final boundary.

  ### 3. Whole-run approval handoff

  - Remove merge/publication from the implementation workflow.
  - After every group converges:
      - Require green hook receipts for the final digests, or successful
        full-suite receipts under the disabled-hook override.

      - Run a report-only review agent per group that returns at least one
        actionable exercise method:
          - A live server URL, or
          - An exact command and working directory.

      - Return readyForApproval, worktree paths, repository graph
        summaries, test receipts, exercise methods, blocked/partial
        results, and preserved recovery refs.

  - Set readyForApproval only when every selected task is done, ownership
    checks and typechecks pass, duplicate occurrences have converged, all
    required test receipts are green, and every group has an exercise
    method. A partial, blocked, clarification, ownership, typecheck, sync,
    or test result keeps the run recoverable but prevents approval and
    finalization.

  - Present one combined approval gate for the entire run. No semantic
    commits, remote pushes, integration merges, base-ref updates, or task
    archival occur before approval.

  - Record approval with the approved manifest digest. If any file,
    branch, base ref, occurrence digest, or test receipt changes
    afterward, invalidate approval and return to review.

  ### 4. Post-approval recursive finalization

  Finalize the approved run recursively, deepest-first. A logical
  repository is finalized once across all groups, avoiding competing base
  updates from parallel groups:

  1. Finalize children first.
      - Each child returns a prepared integration merge OID without
        updating its base ref.
      - Traverse explicit occurrence edges and logical-repository
        dependencies, not path segment depth. Finalize a logical child
        once, then reuse its integration OID at every occurrence gitlink.

  2. Create occurrence commits.
      - In every participating group and occurrence of the current logical
        repository, create one commit for that occurrence's approved own-
        file changes, excluding child gitlinks. Do not create empty
        commits.

  3. Assemble one run-level operation branch for the logical repository.
      - Preserve every occurrence tip under a run-scoped ref.
      - Create a temporary assembly branch at the recorded base OID.
      - Check out each finalized logical child's integration OID at every
        direct child occurrence and create one distinct gitlink-bump
        commit per changed child occurrence, ordered by its path within
        the immediate parent. A parent containing two occurrences of one
        logical child therefore bumps both gitlinks in separate commits.
        This creates one bump per actual parent gitlink for the whole run
        rather than one competing bump in every group.

      - Fetch all participating group/occurrence branches directly from
        their local repository paths and merge each into the assembly
        branch with --no-ff, ordered by group ID and then occurrence path.

      - Resolve conflicts only to the already approved converged tree;
        its child gitlinks must equal the prepared child integration OIDs.
        Abort and require renewed tests and approval if the resulting
        projected tree digest differs.

      - Give the assembly branch the run-scoped operation-branch name in
        the canonical occurrence. For repeated repositories, choose
        lastWriterOccurrence as canonical and retain its full-path suffix.

      - Fetch the canonical result into every other occurrence and fast-
        forward its distinct local occurrence branch to the canonical
        operation OID. This also converges branches from separate parallel
        groups without losing their ancestry.

      - Verify all occurrences now have identical HEAD OIDs and working-
        tree digests.

      - Push only the canonical repeated-repository operation branch to
        origin, after approval, without force.

      - Require any pre-existing remote branch to be an ancestor;
        otherwise abort before base publication.

      - Fetch the pushed canonical branch in every other occurrence and
        verify the operation is an effective no-op.

  4. Prepare the repository merge.
      - Create a real --no-ff merge commit from the recorded base OID and
        canonical operation tip on a temporary integration ref.

      - Do not update baseBranch yet.
      - Record the integration OID and return it to the parent, which uses
        it for every direct gitlink occurrence of that logical child.

  5. Publish only after the root integration commit exists.
      - Revalidate every recorded base OID.
      - Update canonical base refs with compare-and-swap semantics.
      - If any publication fails, roll back already-updated refs to their
        recorded OIDs and preserve integration/recovery refs.

      - Align other occurrences’ local base branches to the canonical
        integration OID through local fetch and fast-forward.

      - Never push base branches automatically.
      - Report exact recovery commands if publication or rollback is
        incomplete.

  - After successful publication, return task-level merged results and
    archive only the explicitly and successfully published task numbers.
    The recorded whole-run approval authorizes this finalization and
    archival; do not introduce a second approval after merging.

  ## Public Interfaces

  - Preparation becomes a resumable two-pass interface:
      - Discovery/setup output may contain resolutionRequests.
      - Resolution input maps repository identities to selected base
        branches and duplicate reconciliation choices.

  - WorkflowArguments and the run manifest carry the recursive repository
    graph, hook mode, test receipts, recovery refs, review handoffs,
    approval digest, occurrence commits, consolidation refs, integration
    OIDs, and publication state.

  - Add deterministic CLIs for:
      - Recursive repository discovery/setup.
      - Repeated-repository file synchronization.
      - Hook sync-receipt verification.
      - Recovery snapshot creation.
      - Approval recording.
      - Post-approval recursive finalization.

  - Workflow output changes from immediate merge results to:
      - readyForApproval
      - reviewHandoffs
      - testReceipts
      - blocked, partial, and clarification results
      - Finalization later returns merged, conflicts, skipped,
        publication, and recovery results.

  ## Test Plan

  - Recursive setup:
      - Root-outward initialization at recorded gitlinks.
      - Nested base discovery with zero, one, and multiple exact branch
        tips.

      - User resolution replay.
      - Identically named operation branches for unique repositories.
      - Full-path suffixes for repeated occurrences.
      - Explicit parent occurrence and path-within-parent resolution for
        submodules nested below ordinary directories.

      - Three or more occurrences of one logical repository without
        pairwise-only assumptions.

  - Duplicate-aware grouping:
      - Tasks naming the same relative file through different occurrences
        are placed in one serial group.

      - Synchronization and ancestor-gitlink effect paths participate in
        overlap detection.

      - Disjoint files in one logical repository may remain parallel and
        their branches both become ancestors of one run-level operation
        branch.

  - Logical repository identity:
      - Relative and absolute URL normalization.
      - SSH/HTTPS aliases.
      - Missing/different URL confirmation.
      - Duplicate commit/base reconciliation.

  - Synchronization:
      - Modified, added, deleted, renamed, executable, symlink, and
        untracked files.

      - Nested submodules excluded from parent file copying.
      - Fixes originating from any occurrence.
      - Fixes originating from any member of a three-occurrence class fan
        out to the other two in one convergence cycle.
      - Digest mismatch prevents readiness.

  - Auto-testing:
      - Ordinary edits resolve the nearest repository.
      - Sync receipts run related tests in every occurrence and complete
        suites in every affected parent through the root.

      - Missing and failing tests block readiness.
      - Disabled-hook override runs full affected suites once before
        approval.

  - Approval:
      - No semantic commit, push, integration merge, or base mutation
        before approval.

      - Every group supplies a URL or command.
      - Post-approval changes invalidate the approval digest.

  - Commit topology:
      - One commit per changed child gitlink.
      - Separate own-files commits contain no child gitlink changes.
      - Nested integration OIDs propagate into every ancestor.
      - Multiple file-disjoint groups merge into one run-level operation
        branch before one base integration merge is prepared.
      - No empty commits.

  - Repeated histories:
      - Independent occurrence commits are all ancestors of the canonical
        merge.

      - Every occurrence branch fast-forwards to one canonical OID.
      - Push occurs only after approval and never uses force.

  - Publication:
      - Integration conflicts leave all base refs unchanged.
      - Base-ref races prevent publication.
      - Partial publication rolls back.
      - Rollback failure preserves refs and exact recovery instructions.

  - RevEng-shaped end-to-end fixture:
      - A recursive root containing tmux_lib at tmux_lib,
        jfred/external/tmux_lib, and
        jfred/jfredToolsPlugin/external/tmux_lib.

      - Include two occurrences each of claude_plugin_lib and scenarios,
        with at least one repeated repository below a nested submodule and
        ordinary directory.

      - A change originating in any tmux_lib copy converges across all
        three; changes in claude_plugin_lib and scenarios converge across
        both of their occurrences.

      - Each logical child's tests and every distinct affected parent
        chain's configured suite pass.
      - Whole-run approval occurs before commits/merges/pushes.
      - Repeated histories consolidate, child integration OIDs propagate
        through the correct explicit parent gitlinks, and every base
        branch ends at the expected merge commit.

      - Assert that no synthetic parents such as jfred/external or
        jfred/jfredToolsPlugin/external are treated as Git repositories.

  ## Assumptions

  - Implementation targets the completed resilient-jumping-meadow branch.
  - Root uses its checked-out branch as base; submodules use an exact
    remote branch-tip match.

  - Ambiguous base discovery and duplicate commit/base mismatches always
    ask the user.

  - Repeated repositories are identified primarily by normalized resolved
    origin URL, with no upper bound of two occurrences.

  - Human approval covers the entire run.
  - The copied taskTools hook is the default test authority.
  - A changed child causes the configured complete suite to run in every
    affected ancestor; related-test filename matching alone is
    insufficient for parent validation.
  - A hook-disabled override is per run and requires full affected suites
    immediately before approval.

  - Repeated occurrences use independent path-suffixed branches, then
    merge those branches into the last-writer occurrence.

  - Only canonical repeated-repository operation branches are pushed;
    unique operation branches and all base branches remain local.

  - Existing Jot files are not modified or removed.
