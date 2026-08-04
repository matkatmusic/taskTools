# Task 9 Plan: Root-outward recursive repository discovery orchestrator

## Confirmed module surface (read while planning)

Unlike an earlier draft of this plan, the five composed modules and
`scripts/repositoryManifest.ts` (the shared type/IO source they all
build on) have already been read in full, along with their test files.
Their real exported surface — use these names/signatures verbatim, do
not re-derive or rename them:

- `scripts/gitlinkReader.ts` → `readDirectGitlinks(repoRoot: string, commitish: string): GitlinkEntry[]`
  where `GitlinkEntry = { path: string; oid: string }`. Runs
  `git -C repoRoot ls-tree -r commitish`, filters to mode `160000`
  (submodule) entries. Requires `repoRoot` to be a real git repository
  on disk with `commitish` present in its object database — it does
  **not** require that repo to be checked out to `commitish`, or to any
  particular branch at all.
- `scripts/baseBranchResolution.ts` → `resolveBaseBranchCandidates(repoPath: string, recordedOid: string): BaseBranchResolution`
  where the result is `{ kind: "single"; baseBranch: string } | { kind: "none"; candidates: [] } | { kind: "multiple"; candidates: string[] }`.
  Reads **local** `refs/heads/` only via `git for-each-ref` — there is
  no fetch step in this module. Do not add one; the brief's "fetch
  branch refs" is satisfied by whatever refs already exist locally in
  the fixture/child repo.
- `scripts/resolutionRequests.ts` → `createResolutionRequest(occurrenceId, recordedOid, candidateBaseBranches, reason)`,
  `recordResolutionRequest(manifest, request)`, `hasResolutionAnswer(manifest, requestId)`,
  `needsResolutionRequest(manifest, occurrenceId, reason)`, `applyResolutionAnswers(manifest, answers)`,
  `createEmptyResolutionManifest()`, plus the reason constants
  `REASON_ZERO_EXACT_TIP_MATCHES` / `REASON_MULTIPLE_EXACT_TIP_MATCHES`
  and the `ResolutionManifest = { resolutionRequests: ResolutionRequest[]; resolutionAnswers: Record<string, string> }`
  shape. Request IDs are a deterministic hash of `occurrenceId + reason`
  (`createResolutionRequestId`), so re-running discovery on the same
  unresolved occurrence reproduces the same request ID — this is what
  makes "resumed run reuses persisted answers" work for free once
  `resolutionAnswers` carries over.
- `scripts/operationBranches.ts` → `setUpOperationBranches(occurrences: RepositoryOccurrence[], runId: string): RepositoryOccurrence[]`
  and `operationBranchName(runId, occurrence): string`. Takes a **batch**
  array (call it with a single-element array for per-occurrence
  granularity — that's a valid, cheap way to get one-at-a-time control).
  It throws `OperationBranchSetupError` if *any* occurrence in the batch
  has `baseBranch === ""` or a detached `checkoutPath`, and
  `OperationBranchConflictError` if a same-named branch already exists
  at a different OID. It reads/writes the real repo at
  `occurrence.checkoutPath` via `git -C checkoutPath`, so
  `checkoutPath` must be a real, absolute (or at least
  process-cwd-relative) filesystem path to an existing git repo — not a
  root-relative logical path.
- `scripts/repositoryGraph.ts` → **read-only traversal only**:
  `getChildren`, `getAncestorChain`, `getDeepestFirstOrder`,
  `getOwningOccurrence`, `getPathWithinRepository`, all taking an
  already-built `RepositoryManifest`. **There is no node-recording /
  graph-builder export here.** An earlier draft of this plan assumed
  one ("add the occurrence to the in-progress repositoryGraph via
  whatever repositoryGraph exports for recording a node") — that
  assumption was wrong. `repositoryDiscovery.ts` must assemble
  `RepositoryOccurrence` records itself (see "Building occurrences"
  below) and only reach for `repositoryGraph.ts` when it needs
  read-only traversal over a manifest it already has (e.g. acceptance
  test 11's "walk root-to-leaf with no gaps" check can use
  `getAncestorChain`).
- `scripts/repositoryManifest.ts` (not one of the five, but the shared
  type/IO source all of them build on) → the `RepositoryOccurrence` and
  `RepositoryManifest` types, plus `readRepositoryManifest(path)` /
  `writeRepositoryManifest(path, manifest)` (file IO) and
  `validateRepositoryManifest(manifest)`. `RepositoryOccurrence` already
  has an `operationBranch: string` field (empty string = not yet
  created) — this doubles as the "operation branch already completed"
  marker Phase B needs, so no separate completion-tracking structure is
  required.

## Scope

- New file only: `scripts/repositoryDiscovery.ts`.
- New test file: `tests/repositoryDiscovery.test.ts`.
- Do not touch the flat-path production code, any CLI entry point, or
  `scripts/mergeTaskWorktrees.ts`. This module is not wired into
  anything until the Phase 4 cutover task — it must be importable and
  fully tested in isolation with zero call sites elsewhere in the repo.
- Do not modify `gitlinkReader.ts`, `baseBranchResolution.ts`,
  `resolutionRequests.ts`, `operationBranches.ts`, or
  `repositoryGraph.ts`. If one of them is missing an export that this
  plan needs, stop and flag it rather than adding new behavior to that
  module as a side effect of this task.

## Behavior, in plain English

`repositoryDiscovery.ts` walks a repository and its nested git
submodules, root-outward, to build a complete map of every
repository occurrence (path, parent, depth, pinned commit, resolved
branch). It never guesses a branch. If any occurrence's commit maps to
zero or more-than-one branch, the whole discovery run reports that as a
list of resolution requests instead of a graph, and it does this before
creating any operation branches — so a caller never receives a graph
that's half-real, half-guessed. A second run, given the same root plus a
manifest of previously-resolved answers, must not re-ask for anything
already answered and must not redo already-created operation branches.

## Two-phase design

Split the orchestrator into a read-only **discovery phase** and a
mutating **operation-branch phase**, gated by full resolution. This is
the direct implication of "never a partially-guessed graph" +
"resumable … without repeating resolved choices or recreating completed
worktrees": if phase 1 finds nothing unresolved, phase 2 runs and
mutates; if it finds anything unresolved, phase 2 never starts.

### Phase A — discover (read-only, no checkouts, no branch creation)

Recursive procedure, starting at the root repository path:

1. Determine this occurrence's identity:
   - `checkoutPath`: an **absolute filesystem path**
     (`path.join(rootPath, relativePath)`, relativePath `""` for root) —
     `operationBranches` runs `git -C checkoutPath ...` against this, it
     must resolve to a real repo directory on disk, not a logical
     root-relative label.
   - `occurrenceId`: none of the five modules generate this, so derive
     it deterministically here — use the root-relative path itself
     (`""` for root, `"jfred"`, `"jfred/external/tmux_lib"`, etc.). It's
     already unique per occurrence and stable across runs, which is
     exactly what resumability needs; don't hash or invent a second ID
     scheme.
   - `parentOccurrenceId` (root-relative parent path, `null` for root),
     `pathInParent` (the gitlink's `path` entry, `null` for root),
     `depth` (`0` for root, else `parentDepth + 1`).
   - pinned commit OID (`baseOid`):
     - root: read the currently checked-out branch name
       (`git symbolic-ref --short HEAD` at `rootPath`; if this fails,
       root is detached — throw rather than emit a resolution request,
       since resolution requests model *ambiguous-or-zero exact tip
       match* for a recorded OID, not "root has no branch to record" —
       this case isn't in the acceptance tests, so fail fast and flag
       it rather than inventing new semantics) and HEAD OID
       (`git rev-parse HEAD`); record both directly — "record the
       root's checked-out branch and OID as its base" — root's
       `baseBranch` is not run through `baseBranchResolution` at all.
     - non-root: the OID recorded for this path in the *parent's*
       gitlink entry (from `gitlinkReader`), not anything read from
       this repo's own working tree
2. Resolve a base branch for this occurrence's OID. Always call
   `resolveBaseBranchCandidates(checkoutPath, baseOid)` first — it's a
   cheap local-refs read, there's no reason to special-case it away.
   Then branch on `result.kind`:
   - `"single"` → `baseBranch = result.baseBranch` directly. Resolved,
     no resolution request involved at all (this is the common,
     unambiguous case).
   - `"none"` or `"multiple"` → this is where "without repeating
     resolved choices" applies. Compute
     `reason = result.kind === "none" ? REASON_ZERO_EXACT_TIP_MATCHES : REASON_MULTIPLE_EXACT_TIP_MATCHES`
     and `requestId = createResolutionRequestId(occurrenceId, reason)`.
     - If `hasResolutionAnswer(manifest.resolutionManifest, requestId)`
       is true → reuse `manifest.resolutionManifest.resolutionAnswers[requestId]`
       as `baseBranch` directly. Resolved; do **not** call
       `createResolutionRequest`/`recordResolutionRequest` again for it.
     - Otherwise → build the request via `createResolutionRequest(occurrenceId, baseOid, result.candidates, reason)`,
       append it via `recordResolutionRequest(manifest.resolutionManifest, request)`,
       and leave this occurrence's `baseBranch` as `""` (unresolved) for
       this run. Do **not** invent a `baseBranch` value.
3. Build the `RepositoryOccurrence` record by hand (there is no builder
   export to call — see "Confirmed module surface" above) and push it
   onto the manifest's `occurrences: RepositoryOccurrence[]` array,
   whether or not `baseBranch` resolved this call. Unresolved
   occurrences get `baseBranch: ""` and `baseOid` still set (the OID is
   known even when the branch isn't) so the record is present for
   `repositoryGraph.ts` traversal helpers and for a later resumed run
   to find and re-check.
4. Read this occurrence's **direct** gitlinks via `gitlinkReader`,
   reading from the occurrence's pinned commit (not from a checked-out
   working tree — the root is the only occurrence guaranteed to be
   checked out at this point, and even it is read via its recorded
   OID, not by re-reading a live worktree that a later phase might have
   moved). This is what makes it safe to keep recursing into children
   of an unresolved node: gitlink reads don't require a resolved branch
   or a checkout.
5. For each direct gitlink entry, recurse (step 1) with that entry as
   the child occurrence, this occurrence as its parent.
6. A "direct gitlink" is only an actual git submodule entry recorded in
   the parent commit's tree/`.gitmodules` — a directory that merely
   contains submodules several levels down (e.g. `jfred/external/`
   holding `tmux_lib` as a submodule, where `jfred/external` itself is
   not a submodule) must never become a graph node. Its child
   (`jfred/external/tmux_lib`) is still discovered, but its recorded
   `parent` is the nearest actual repository occurrence above it in the
   tree (`jfred`), not the intermediate path. Whatever `gitlinkReader`
   returns should already be limited to real gitlink entries; if it
   is, this falls out for free — don't add synthetic-path filtering on
   top unless reading the module shows it's actually needed.

Phase A's result: every occurrence reachable from root has been pushed
onto `manifest.repositoryManifest.occurrences` (correct parent
edges/depths, resolved or unresolved), plus a `pendingResolutionRequests: ResolutionRequest[]`
list local to *this call* — collect it by pushing the request returned
from `createResolutionRequest` each time step 2 hits the
"otherwise" branch. Use this local list, not
`manifest.resolutionManifest.resolutionRequests` in full, to decide
`DiscoveryResult` — the manifest's full request list may carry
already-answered entries from earlier runs; what determines
`"resolved"` vs `"needsResolution"` is whether *this run* still has any
occurrence left with `baseBranch === ""` after Phase A, i.e. whether
`pendingResolutionRequests` is empty.

### Phase B — create operation branches (mutating, only if Phase A found nothing unresolved)

Only runs when `pendingResolutionRequests` from Phase A is empty. Walk the
same graph root-outward (parents before children — the order Phase A
already discovered them in is already root-outward, so no separate
sort/second traversal is needed, reuse Phase A's visitation order):

1. For each occurrence, if `occurrence.operationBranch !== ""`, skip it
   — that field is already the "operation branch already completed"
   marker (see "Confirmed module surface"), no separate completion set
   is needed ("without … recreating completed worktrees").
2. Otherwise call `setUpOperationBranches([occurrence], runId)` (single
   -element array — see the module's real batch signature above) and
   replace this occurrence's entry in the manifest's `occurrences` array
   with the returned, now-`operationBranch`-populated record.
3. Persist that replacement into the manifest immediately after each
   successful call (not batched at the end) — so an interrupted run
   resumes without redoing branches that already exist. "Persist" here
   means: the caller's `manifest.occurrences` array is mutated/updated
   in place before moving to the next occurrence — there is no on-disk
   write inside `repositoryDiscovery.ts` itself (see "Manifest" below).

Phase B's result: the same `manifest.occurrences`, now with every
occurrence's `operationBranch` field populated.

### Top-level entry point

One exported function:
`discoverRepositoryTree(rootPath: string, manifest: DiscoveryManifest): DiscoveryResult`.
Shape:

```ts
type DiscoveryResult =
    | { status: "resolved"; graph: RepositoryOccurrence[] }
    | { status: "needsResolution"; resolutionRequests: ResolutionRequest[] };
```

`RepositoryOccurrence` comes from `repositoryManifest.ts` and
`ResolutionRequest` from `resolutionRequests.ts` — import both, do not
redeclare equivalent shapes locally.

### Manifest

`DiscoveryManifest` is a plain in-memory composition of the two
manifest shapes the composed modules already define — no new
persistence mechanism, no file IO inside this module:

```ts
type DiscoveryManifest = {
    repositoryManifest: RepositoryManifest;   // from repositoryManifest.ts — occurrences[] built/updated by this module
    resolutionManifest: ResolutionManifest;   // from resolutionRequests.ts — requests + prior answers
};
```

`discoverRepositoryTree` reads and mutates
`manifest.repositoryManifest.occurrences` (Phase A appends, Phase B
updates in place) and `manifest.resolutionManifest` (Phase A appends
new requests via `recordResolutionRequest`/`createResolutionRequest`,
reads prior answers via `hasResolutionAnswer`/`resolutionAnswers`).
Callers that want on-disk persistence between runs use the already
-exported `readRepositoryManifest` / `writeRepositoryManifest` from
`repositoryManifest.ts` for the graph half, and plain
`JSON.stringify`/`JSON.parse` for the `resolutionManifest` half (it has
no dedicated file-IO export and doesn't need one for Phase 1 — tests
call `discoverRepositoryTree` twice with the same in-memory
`DiscoveryManifest` object to prove resumability, they don't round-trip
through disk).

## Order of implementation (TDD, red-green, root-outward granularity)

Write these in `tests/repositoryDiscovery.test.ts`, each red before its
green, smallest behavior first. Note on the test descriptions below:
"`parentPath`" is shorthand for the `parentOccurrenceId` field — since
`occurrenceId` is itself the root-relative path (see step 1 above),
checking "does the parent path equal X" and "does `parentOccurrenceId`
equal X" are the same assertion. Likewise `result.graph` (when
`status === "resolved"`) is `manifest.repositoryManifest.occurrences`
at the point Phase B finishes.

1. `test_discoverRootOnlyRepository_recordsRootBranchAndOidAsBase`
   - Scenario: verify a repo with no submodules produces a one-node
     graph.
   - Steps: create a fixture repo with a commit on a named branch. Run
     discovery. Assert the graph has exactly one occurrence, depth 0,
     parent null, `baseBranch` equal to the checked-out branch name,
     OID equal to HEAD.

2. `test_discoverThreeLevelFixture_producesCorrectParentEdgesAndDepths`
   - Scenario: root → child → grandchild, each an unambiguous single
     branch at its pinned OID.
   - Steps: build the three-level fixture. Run discovery. Assert three
     occurrences exist, each with the expected `parentPath` and depth
     (0, 1, 2), and each with a resolved `baseBranch`.

3. `test_discoverSubmoduleAtJfredExternalTmuxLib_recordsParentAsJfred`
   - Scenario: verify a submodule nested two directory levels below its
     containing repo (but only one submodule level deep) records the
     containing repo as parent, not the intermediate path.
   - Steps: build a fixture with repo `jfred` containing a submodule at
     `external/tmux_lib` (i.e. gitlink path `external/tmux_lib`, no
     submodule at `external` itself). Run discovery rooted above
     `jfred`. Assert the `tmux_lib` occurrence's `parentPath` equals
     `jfred`'s path, not `jfred/external`.

4. `test_discoverSubmoduleBelowJfredToolsPlugin_recordsThatRepositoryAsParent`
   - Scenario: verify a submodule directly inside another submodule
     repository is parented to that repository.
   - Steps: extend the fixture so `jfred/jfredToolsPlugin` is itself a
     submodule with its own direct submodule beneath it. Run discovery.
     Assert the innermost occurrence's `parentPath` equals
     `jfred/jfredToolsPlugin`.

5. `test_discoverTree_neverRecordsSyntheticIntermediateDirectoryAsRepository`
   - Scenario: verify no graph node exists for a path that is a plain
     directory, not a real gitlink target.
   - Steps: using the fixture from test 3, run discovery, assert no
     occurrence in the graph has path `jfred/external`.

6. `test_discoverTreeWithAmbiguousBranchTip_returnsResolutionRequestNotGraph`
   - Scenario: verify an OID matching two branch tips produces a
     resolution request instead of a guessed graph.
   - Steps: build a fixture where a child's pinned OID has two branches
     pointing at it. Run discovery. Assert `status === "needsResolution"`,
     assert the resolution request identifies that occurrence, and
     assert no `graph` is returned.

7. `test_discoverTreeWithDetachedOid_returnsResolutionRequestNotGraph`
   - Scenario: verify an OID matching zero branch tips (detached)
     produces a resolution request.
   - Steps: build a fixture where a child's pinned OID has no branch
     pointing at it. Run discovery. Assert `status === "needsResolution"`
     and the request identifies that occurrence.

8. `test_discoverTreeWithUnresolvedRepository_stopsBeforeCreatingOperationBranches`
   - Scenario: verify Phase B never runs when Phase A is unresolved.
   - Steps: reuse the fixture from test 6 or 7. Run discovery. Assert
     every occurrence in `result` (or the manifest, since Phase A
     already wrote to it) has `operationBranch === ""` — the field
     doubles as proof no branch was created, no separate inspection API
     is needed.

9. `test_resumedDiscoveryRun_reusesPersistedAnswerWithoutReResolving`
   - Scenario: verify a manifest with a pre-recorded answer for an
     ambiguous occurrence is honored instead of producing another
     resolution request.
   - Steps: reuse the fixture from test 6. Build a manifest with the
     ambiguous occurrence's path pre-answered to one of the two
     candidate branches. Run discovery with that manifest. Assert
     `status === "resolved"`, the graph exists, and that occurrence's
     `baseBranch` equals the pre-answered branch.

10. `test_resumedDiscoveryRun_doesNotRecreateCompletedOperationBranches`
    - Scenario: verify a manifest marking an occurrence's operation
      branch as already created is not recreated — proven
      behaviorally, without mocking `operationBranches` (node:test's
      ESM imports aren't easily mockable, and the field-based
      completion marker makes this observable without a spy anyway).
    - Steps: run discovery once on a fully-resolvable fixture to
      completion, capturing the resulting manifest. For one child
      occurrence, manually `git -C <its checkoutPath> checkout <its
      baseBranch>` (i.e. move it off the operation branch Phase B just
      created). Run discovery again, passing the same manifest (which
      still has `operationBranch` populated for that occurrence). After
      the second run, assert that occurrence's checked-out branch in
      its working tree is still the one manually set (not the
      operation branch) — proving Phase B's loop skipped it rather than
      re-calling `setUpOperationBranches`, which would have checked the
      operation branch back out.

11. `test_discoverUniqueDeeplyNestedTree_isReadyForDryRunIntegration` (Phase 1 acceptance)
    - Scenario: the brief's acceptance bar — a unique, deeply nested
      tree can be discovered, branched at recorded commits, and
      dry-run integrated using explicit parent edges.
    - Steps: build (or reuse, if a suitable fixture already exists from
      the five composed modules' own tests — check before building a
      new one) a fixture at least as deep as root → child → grandchild
      → great-grandchild, mixing regular submodules and the
      `jfred`-shaped nesting from tests 3–4. Run discovery to
      completion. Assert `status === "resolved"`, every occurrence has
      a created operation branch, and every occurrence's `parentPath`
      correctly chains back to root with no gaps or synthetic nodes.
      This test does not need to invoke whatever later phase performs
      real worktree integration — "dry-run integrated using explicit
      parent edges" is satisfied by asserting the graph's parent edges
      are complete and walkable root-to-leaf; do not build a dry-run
      integrator here, that belongs to a later phase.

For each test, write the failing version first, then add the minimum
code in `scripts/repositoryDiscovery.ts` to make it pass before moving
to the next test. Later tests will exercise code paths added for
earlier ones — don't re-derive already-covered behavior.

## Fixture reuse

`tests/gitlinkReader.test.ts` already has the closest fixture builder:
`makeTempRepoWithCommit()` (bare temp repo + seed commit) and
`makeParentRepoWithGitlinks()` (creates two real submodules via
`git submodule add -q <origin> <path>` with
`process.env.GIT_ALLOW_PROTOCOL = "file"`, including the exact
`external/tmux_lib` two-level-path-but-one-submodule-level shape this
task's tests 3/5 need). Port/extend that pattern into
`tests/repositoryDiscovery.test.ts` instead of writing a fresh one —
in particular, reuse its `git submodule add` + `file://`-origin
approach for building the three/four-level nested fixtures, and its
`external/tmux_lib` shape verbatim for tests 3 and 5. Note real
`git submodule add` also checks the child out at that OID — that's
fine, discovery must not depend on that (see step 4's "not from a
checked-out working tree" note), but it does mean the child repo is
always present and valid at its recorded OID for `readDirectGitlinks`
to walk into it.

For the ambiguous/detached-OID fixtures (tests 6–7), build on a plain
`makeTempRepoWithCommit()`-style child repo and add/remove
`refs/heads/*` branches directly with `git branch`, mirroring
`baseBranchResolution.test.ts`'s `createBranchAtCurrentHead` helper —
that file is the fixture to crib from for those two tests specifically.

## Naming

Within the new file, name the recursive worker something that states
what it does at each call, e.g. `discoverOccurrenceAndDescendants(...)`,
not a generic `walk`/`visit`. Avoid one-letter or abbreviated params
(`repositoryRoot`, `commitOid`, `occurrencePath` etc. — avoid `r`, `o`,
`p`).

## Out of scope for this task

- Wiring `repositoryDiscovery.ts` into any CLI, workflow, or the
  existing flat-path production code (Phase 4).
- Building the actual dry-run integrator / worker worktree creation —
  only the graph + operation branches described above.
- Modifying any of the five composed modules, even if their exports
  turn out to be slightly awkward to compose — flag and work around in
  the new file, don't change their public surface.
