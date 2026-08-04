# Task 25 Plan: Per-repository finalizer (own-files commit, durable refs, gitlink bumps)

## Why (one paragraph, for reference during implementation)
This is Phase 3 of the recursive repository-discovery redesign. Phases 1/2
(discovery, authorization, occurrence/branch naming — see tasks 13/14/16/17/18)
already produce: an authorization gate (`scripts/runAuthorization.ts`), the
recursive graph of "occurrences" (a repo can appear more than once under a
parent, and a repo can itself have child occurrences), and deterministic
per-occurrence branch names. Phase 3 turns the *approved, staged* own-file
changes on each occurrence branch into real commits, without ever touching a
mutable base ref, then stitches child results into each parent via one
gitlink-bump commit per changed path. This module produces finalized OIDs and
refs only — it does not update any long-lived branch and does not push.
Nothing calls it yet.

## Before writing any code: discovery step (mandatory)
This plan was written from the brief only — the exact shapes of
"authorization", "occurrence", "explicit occurrence edge", "recorded base",
and "group/occurrence branch" come from already-merged modules in this repo.
Before writing `scripts/runFinalizer.ts`, read:
- `scripts/runAuthorization.ts` — its exported function/type is the *only*
  legal way to check authorization; do not reimplement or bypass it. Finalizer
  must call it and throw/refuse if it does not grant authorization.
- `scripts/occurrenceBranchNames.ts` (task 14) — reuse its naming/lookup
  helpers for occurrence branch names rather than recomputing them.
- The task-13/16/17/18 plans and whatever discovery module they produced —
  find the type that represents a logical repository's recorded base, its
  list of participating group/occurrence branches, its explicit occurrence
  edges to children, and per-branch "approved own-file changes". Reuse those
  types as-is; do not invent parallel ones.
- Whatever git-invocation wrapper the existing scripts already use (grep
  `scripts/*.ts` for how they shell out to git / which library). Reuse it —
  do not add a new git library dependency (ponytail rung 5: an
  already-installed dependency, or the existing in-house wrapper, beats a new
  one).

If any of the above types/helpers turn out not to exist yet, stop and treat
this as a blocking gap rather than guessing their shape — the finalizer's
correctness depends on matching them exactly.

## Scope guardrails
- New file(s) only: `scripts/runFinalizer.ts` + `tests/runFinalizer.test.ts`.
  No edits to any other production file, no new call sites.
- Never call `git push` or touch any remote.
- Never write to a logical repository's recorded base ref — only read it (to
  seed the temporary assembly branch's start point).
- Never create an empty commit.
- Own-file commits must never touch a gitlink path.
- Keep `scripts/runFinalizer.ts` under the 250-line cap. If the full
  algorithm won't fit, split pure/stateless pieces (topological ordering,
  changed-gitlink-path diffing, durable-ref name building) into a sibling
  module up front — do not write past the cap and split afterward.

## Algorithm, in order

### Step 1 — Authorize
Call the existing `scripts/runAuthorization.ts` authorization entry point
first, with whatever inputs it requires. If it does not authorize, throw and
do nothing else (no commits, no refs, no branches). This must be the first
thing the finalizer does.

### Step 2 — Topological order (children before parents)
Build a child-before-parent processing order over the repositories using
their explicit occurrence edges. A repo may occur under more than one parent
and a repo may have multiple distinct children, so this is a DAG, not a tree:
use a plain Kahn's-algorithm-style queue (in-degree counting) or a recursive
post-order visit with a "visited" set — either is a few lines with arrays and
a Set/Map, no graph library needed (ponytail rung 3/6: stdlib collections are
enough for this size of graph).

### Step 3 — Own-files commit + durable ref, per repo, per participating branch
Process repos in the Step 2 order. For each repo, for each of its
participating group/occurrence branches:
1. Take that branch's approved own-file change set (already excludes
   gitlinks per the upstream discovery/authorization data — do not
   re-derive it; if the upstream type does *not* already guarantee "no
   gitlink paths", filter out any path that is a submodule/gitlink entry
   before committing).
2. If the change set is empty, do **not** create a commit — the durable ref
   for this branch simply points at the branch's current tip. (The brief
   requires "no empty commits" and, separately, "durable refs exist for
   every group tip" — an unchanged branch satisfies both by pointing the
   durable ref at the existing tip.)
3. Otherwise create exactly one commit on top of the branch tip containing
   only that change set.
4. Write a run-scoped durable ref for this tip, e.g.
   `refs/finalizer/<runId>/<repoPath>/<branchName>`. Build this name with one
   small pure helper (e.g. `runFinalizer_durableRefName(runId, repoPath,
   branchName): string`) so its format is independently testable.
5. Record the resulting OID as that branch's "finalized integration OID" —
   this is what parents will bump their gitlink to in Step 4.

### Step 4 — Assembly branch + gitlink bumps, per logical repository
Still in Step 2's order (a repo's children are already finalized by the time
the repo itself is processed):
1. Create one temporary assembly branch at the repo's recorded base (read
   from the discovery data, not from the branch's live HEAD — this is what
   keeps the base ref itself untouched).
2. Collect this repo's direct child occurrences (explicit occurrence edges),
   each with its gitlink path in this repo and its child's finalized
   integration OID from Step 3.
3. Sort those paths lexicographically (deterministic "ordered by path"
   requirement).
4. For each path, in that order: if the gitlink already equals the child's
   finalized OID, skip it — no commit. Otherwise set the gitlink to the
   child's finalized OID and create exactly one commit for that single path
   change. A logical child that occurs at multiple paths under the same
   parent produces one bump commit per changed path, all pointing at the
   same child OID.
5. The assembly branch's final tip after all bump commits is this repo's own
   finalized integration OID, available to *its* parent in the next Step 4
   iteration (this is how nested OIDs propagate to the root).

### Step 5 — Return value
Return, per repository: the durable ref name(s) and OID(s) from Step 3, the
temporary assembly branch name and final OID from Step 4, and the ordered
list of gitlink-bump commit OIDs. No caller consumes this yet, but the shape
should let a future orchestrator find every durable ref and every assembly
tip without re-deriving them.

## Testing plan (write RED before GREEN, one behavior per test)

Plain-English behavior, then the test to prove it. Use whatever test-repo
fixture helper the sibling test suite (`tests/relatedTests.test.ts` or
neighboring task-14/18 tests) already uses to build a throwaway git repo —
reuse it rather than writing a new one.

1. `test_ownFilesCommitContainsNoGitlinkChanges` — given a branch with
   approved own-file changes and an untouched gitlink, run the finalizer and
   assert the resulting own-files commit's diff touches none of the
   repo's gitlink paths.
2. `test_noCommitCreatedWhenBranchHasNoApprovedChanges` — given a branch with
   an empty approved change set, assert its durable ref resolves to the
   branch's pre-existing tip OID (no new commit object created).
3. `test_oneBumpCommitPerChangedDirectChildOccurrence` — a parent with two
   distinct child occurrences whose finalized OIDs differ from the parent's
   current gitlinks: assert exactly two bump commits exist, one per path.
4. `test_noBumpCommitForUnchangedChildOccurrence` — a parent with one child
   occurrence whose gitlink already equals the child's finalized OID: assert
   zero bump commits are created for that path.
5. `test_repeatedChildOccurrenceUpdatesAllPathsToSameOid` — a parent
   containing the same logical child at two different paths: assert both
   paths end up set to that child's one finalized integration OID, via two
   separate bump commits.
6. `test_bumpCommitsOrderedByPathWithinParent` — a parent with changed
   gitlinks at paths `["b/child", "a/child"]` (declaration order):
   assert the bump commits were created in `["a/child", "b/child"]` order.
7. `test_nestedChildOidsPropagateThroughExplicitParentEdgesToRoot` — a
   three-level chain (grandchild -> child -> root) each with their own
   approved own-file change: assert the root's final assembly OID reflects
   the grandchild's finalized OID having flowed through the child's bump
   commit into the root's bump commit.
8. `test_durableRefExistsForEveryGroupTip` — for a repo with multiple
   participating group/occurrence branches, assert every branch has a
   resolvable durable ref after the run.
9. `test_baseRefUnchangedAfterFinalizerRuns` — record each repo's recorded
   base ref OID before the run, run the finalizer, assert every one of those
   OIDs is identical after (this is the base-ref-immutability guarantee;
   implement it as a real equality assertion, not a mock/spy).
10. `test_finalizerRefusesWithoutAuthorization` — call the finalizer with an
    authorization input that `runAuthorization.ts` rejects: assert it throws
    before creating any commit, branch, or ref.
11. `test_finalizerNeverInvokesPush` — spy on/wrap the shared git-invocation
    wrapper (whatever Step-0 discovery finds) for the duration of one run and
    assert no invocation's arguments include `push`.

Write each test's body as PLAIN ENGLISH step comments first (per
`~/.claude/guides/tdd.md`), confirm it fails for the right reason, then add
the minimum code in `scripts/runFinalizer.ts` (and any split-out sibling
helper module from the guardrails section) to make it pass, one test at a
time, in the numeric order above (own-files commit correctness before bump
logic, unchanged-vs-changed before repeated-path, single-parent bump before
multi-level propagation, then the two whole-run invariants last since they
depend on everything else already working).

## Naming (per coding-standards.md)
- Prefix pure helper functions with `runFinalizer_` (e.g.
  `runFinalizer_durableRefName`, `runFinalizer_topologicalOrder`,
  `runFinalizer_changedGitlinkPaths`) so their origin module is obvious at
  call sites, matching the existing `git_*`/`tmux_*` style already used in
  this codebase's guides.
- Name the main export for what it does, e.g. `finalizeRepositories(...)` or
  `runFinalizer(...)` — confirm no export-name collision with
  `runAuthorization.ts`'s own entry point before settling on the name.
