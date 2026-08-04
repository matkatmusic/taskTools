# Task 25 Plan: scripts/runFinalizer.ts

## Goal
New module, `scripts/runFinalizer.ts` (+ a git-plumbing helper file if the
250-line cap forces a split), that finalizes a repository-occurrence graph
bottom-up: one own-files commit per occurrence, a durable ref per occurrence
tip, and — for occurrences with children — one temporary assembly branch
carrying one gitlink-bump commit per changed child path. No production call
site yet. No file besides the two new module files and their test file.

## Required reads before writing any code
This plan was authored from `plans/brief-25.md` only, per this task's
constraint. Before implementing, read these — their exact exported
names/shapes drive the plumbing below and are deliberately not guessed here:
- `scripts/runAuthorization.ts` — exact exported token type and the
  verify/assert entry point the finalizer must call first.
- `scripts/ownershipSnapshots.ts` — exact `Change` field names. The plan
  below only relies on `type`, `path`, and (for renames) `oldPath` existing
  on `Change` — confirm those names before writing `commitOwnFileChanges`.
- `scripts/repositoryIntegration.ts` — exact signature/return shape of
  `substituteGitlink` (the plan assumes `(repoRoot, {parentCommitOid,
  pathInParent, childOid}) => string`, returning a new commit oid without
  moving any ref).
- `scripts/logicalRepository.ts` / `scripts/repositoryGraph.ts` — check
  whether `LogicalRepository`/`RepositoryOccurrence` already cover the local
  input type below; import instead of duplicating wherever they do. Per the
  brief, anything not already exported there is defined locally in
  `runFinalizer.ts` as an input parameter — that is not a blocking gap, do
  not stop and report it as one.
- An existing `.test.ts` file in `tests/` (e.g. `tests/relatedTests.test.ts`)
  — match its test runner/import style and naming so
  `tests/runFinalizer.test.ts` fits the codebase.

## Local types to define in scripts/runFinalizer.ts
No repository/occurrence graph traversal helper is listed among the
available primitives, and the brief says to take what's missing as an input
parameter rather than search for it — so the run's shape is a flat list of
per-occurrence inputs, with the tree/graph shape expressed only as edges on
each entry:

```ts
type ChildOccurrenceEdge = {
    pathInParent: string;
    childOccurrenceId: string;
};

type OccurrenceFinalizationInput = {
    occurrenceId: string;
    repoRoot: string;
    currentTipOid: string;
    recordedBaseOid: string;
    approvedOwnFileChanges: Change[]; // from ownershipSnapshots.ts, already filtered to non-gitlink
    directChildEdges: ChildOccurrenceEdge[];
};

type FinalizationRunInput = {
    runId: string;
    occurrences: OccurrenceFinalizationInput[];
};

type BumpCommit = {
    pathInParent: string;
    childOccurrenceId: string;
    commitOid: string;
};

type OccurrenceFinalizationResult = {
    occurrenceId: string;
    ownFilesCommitOid: string;       // === currentTipOid when no own-file changes were approved
    durableTipRef: string;
    finalizedIntegrationOid: string; // what a parent's gitlink bump must point a path at
    assemblyBranchRef: string | null; // null when the occurrence has no direct children
    bumpCommits: BumpCommit[];
};

type FinalizationRunResult = {
    runId: string;
    occurrences: OccurrenceFinalizationResult[];
};
```

`occurrenceId` is the key used both to index results and as the
`childOccurrenceId` any parent's `directChildEdges` references — every
`childOccurrenceId` in the input must resolve to an entry in `occurrences`,
or the run throws (see Step 1).

## Why finalizedIntegrationOid is defined this way
For a leaf occurrence (no children), `finalizedIntegrationOid` is the
own-files commit tip. For an occurrence with children, it is the tip of its
own assembly branch (recordedBaseOid + bump commits) — **not** a merge of
that with the own-files commit. This is the only definition that makes a
nested child's OID visible in the root's bump commit (required test:
nested propagation), since the own-files line and the gitlink-integration
line are two separate, unmerged constructs in this phase — merging them
(via `prepareNoFfMerge`, already available but intentionally unused here)
is a later phase's job, not this one's.

## Ref naming (own namespace, so base refs are trivially untouched)
- Durable tip ref: `refs/finalize/<runId>/tip/<occurrenceId>`
- Assembly branch ref: `refs/finalize/<runId>/assembly/<occurrenceId>`

Never write to `refs/heads/...` or any ref the caller passed in as
`recordedBaseOid`/`currentTipOid` — those are oids read once at the start,
never refs the finalizer resolves live or writes back to.

## Algorithm (in scripts/runFinalizer.ts)

**Step 0 — authorize.** First line of `runFinalizer`: verify the
`RunAuthorization` token via whatever `runAuthorization.ts` exports. Throw
before touching git if invalid. Nothing below runs on an unauthorized call.

**Step 1 — topological sort, children first.** Post-order DFS over
`occurrences` using `directChildEdges`. Use gray/black marking to detect
cycles (throw with the cycle's occurrenceIds). Throw if any
`childOccurrenceId` has no matching entry in `occurrences`. Result: a
processing order where every occurrence appears after all of its direct and
transitive children.

**Step 2 — per occurrence, in that order:**

a. `commitOwnFileChanges(occurrenceRoot=repoRoot, currentTipOid, changes=approvedOwnFileChanges)`:
   - If `changes.length === 0`: return `currentTipOid` unchanged. No commit
     object is created. (No empty commits, ever.)
   - Else: assert none of the changes touch a gitlink path (defensive check
     — guaranteed by the caller already filtering, but it's the one
     invariant this whole task exists to uphold, so check it here too).
     Stage **exactly** the changed paths — never `git add -A` / `git add .`,
     which could sweep in unrelated dirty gitlink state in the working
     tree:
     - added/modified/mode-changed/symlink-changed: `git -C repoRoot add -- <path>`
     - deleted: `git -C repoRoot add -- <path>` (works for a path already
       removed from disk — stages the deletion)
     - renamed: `git -C repoRoot add -- <oldPath> <newPath>`
   - `git -C repoRoot write-tree` → `newTreeOid` (reflects `currentTipOid`'s
     tree plus only the staged paths — this assumes the working tree's
     index otherwise matches `currentTipOid`; confirm this precondition
     against how `occurrenceRoot` is normally kept in sync, from the
     required reads above).
   - `git -C repoRoot commit-tree <newTreeOid> -p <currentTipOid> -m "finalize: own-file changes for <occurrenceId> (<runId>)"` →
     `ownFilesCommitOid`. `commit-tree` never moves HEAD or any branch ref —
     this is what keeps the real base/group branch untouched.

b. `git -C repoRoot update-ref refs/finalize/<runId>/tip/<occurrenceId> <ownFilesCommitOid>`
   — durable ref, written unconditionally (changed or not).

c. If `directChildEdges.length === 0`: `finalizedIntegrationOid =
   ownFilesCommitOid`, `assemblyBranchRef = null`, `bumpCommits = []`. Move
   on to the next occurrence — no assembly branch is created when there is
   nothing to bump.

d. Else, build the assembly branch:
   - Sort `directChildEdges` by `pathInParent` ascending (required
     ordering for bump commits).
   - `let assemblyTip = recordedBaseOid`.
   - For each edge, in that sorted order:
     - `childOid = results.get(edge.childOccurrenceId).finalizedIntegrationOid`
       (already computed — children were processed first in Step 1).
     - `existingGitlinkOid = readGitlinkOid(repoRoot, assemblyTip, edge.pathInParent)`
       via `git -C repoRoot ls-tree <assemblyTip> -- <pathInParent>`,
       parsing the oid column of a `160000 commit <oid>\t<path>` line.
     - If `existingGitlinkOid === childOid`: skip — no commit for an
       unchanged gitlink.
     - Else: `assemblyTip = substituteGitlink(repoRoot, {parentCommitOid: assemblyTip, pathInParent: edge.pathInParent, childOid})`;
       push `{pathInParent, childOccurrenceId: edge.childOccurrenceId, commitOid: assemblyTip}`
       onto `bumpCommits`.
   - `git -C repoRoot update-ref refs/finalize/<runId>/assembly/<occurrenceId> <assemblyTip>`.
   - `finalizedIntegrationOid = assemblyTip`, `assemblyBranchRef =` that ref
     name.

**Step 3 — return** `{ runId, occurrences: [...results in input order] }`
(input order, not topological order, so callers can zip results back to
their original request list by index).

## File layout
Put the plumbing helpers (`commitOwnFileChanges`, `readGitlinkOid`, the
topological sort) in `scripts/runFinalizer.ts` first; only split into a
second file (e.g. `scripts/runFinalizerGitOps.ts`) if the 250-line cap
forces it. Keep `runFinalizer()` itself — the orchestration in Step 1–3 —
as the last, top-level exported function so it reads as the entry point.

## Tests (tests/runFinalizer.test.ts)
Use real temp git repos (one dir per occurrence, `git init` +
`hash-object`/`commit-tree` to seed a starting commit with a couple of
tracked files and, where needed, a `160000` gitlink tree entry pointing at
another occurrence's starting oid) — no mocking of git itself, since the
whole point under test is real tree/commit shape. Match the existing test
file's runner/style (see Required reads). Write each test's body as
plain-English step comments first (per `~/.claude/guides/tdd.md`), confirm
it fails for the right reason, then add the minimum code to pass — one test
at a time, roughly in the order below (own-files commit correctness before
bump logic, single-parent bump before multi-level propagation, whole-run
invariants last since they depend on everything else already working).

1. `test_ownFilesCommitContainsNoGitlinkChange` — occurrence has a gitlink
   entry plus a regular file at its tip; `approvedOwnFileChanges` touches
   only the regular file. Assert the resulting `ownFilesCommitOid`'s tree
   has the identical gitlink oid at the same path as the parent tip (diff
   the two trees; only the non-gitlink path differs).

2. `test_noEmptyOwnFilesCommitWhenNoApprovedChanges` — `approvedOwnFileChanges = []`.
   Assert `ownFilesCommitOid === currentTipOid` (no new commit object was
   created at all).

3. `test_oneBumpCommitPerChangedDirectChildOccurrence_noneForUnchanged` —
   parent occurrence with two direct child edges: one whose child's
   `finalizedIntegrationOid` differs from the tip's current gitlink, one
   whose child's `finalizedIntegrationOid` already matches it. Assert
   `bumpCommits.length === 1` and it names the changed child's path; assert
   `git rev-list recordedBaseOid..assemblyTip` has exactly one commit.

4. `test_multipleGitlinksToSameChildAllUpdatedToSameOid` — parent has two
   `directChildEdges` at different `pathInParent`s pointing at the same
   `childOccurrenceId`. Assert both paths' final gitlink oid (read via
   `ls-tree` on the final assembly tip) equal that child's
   `finalizedIntegrationOid`, and `bumpCommits.length === 2` (one per
   changed path, not one per logical child).

5. `test_bumpCommitsOrderedByPathWithinParent` — parent with two changed
   gitlinks declared in order `["b/child", "a/child"]`. Assert the
   `bumpCommits` array is ordered `["a/child", "b/child"]`.

6. `test_nestedChildOidsPropagateThroughEachExplicitParentEdgeToRoot` —
   three occurrences, root → mid → leaf, each linked by an explicit
   `directChildEdges` entry. Leaf has an own-file change (so leaf's
   `finalizedIntegrationOid` is a new commit). Assert mid's
   `finalizedIntegrationOid` is a new commit (its assembly tip, distinct
   from `mid.recordedBaseOid`) whose gitlink at the leaf's path equals
   leaf's `finalizedIntegrationOid`. Assert root's `finalizedIntegrationOid`'s
   gitlink at mid's path equals mid's `finalizedIntegrationOid` — then walk
   one level further and assert that oid's own gitlink at the leaf's path
   still equals leaf's `finalizedIntegrationOid`, proving the propagation
   is real (not two independently-equal values).

7. `test_durableRefsExistForEveryOccurrenceTip` — run over several
   occurrences (mix of empty and nonempty own-file changes). For each,
   assert `refs/finalize/<runId>/tip/<occurrenceId>` resolves and equals
   the returned `ownFilesCommitOid`.

8. `test_baseRefsAreProvablyUnchanged` — before the run, record each
   occurrence's real branch ref oid (whatever ref `currentTipOid` was read
   from) and `recordedBaseOid`'s ref if one exists. Run the finalizer.
   Assert every one of those refs still resolves to the identical oid
   afterward, and enumerate refs before/after to assert nothing outside
   `refs/finalize/<runId>/...` was created or moved.

9. `test_unauthorizedRunIsRejected` — call `runFinalizer` with an
   invalid/absent authorization token. Assert it throws and that no ref
   under `refs/finalize/...` was created (nothing ran).

## Naming (per coding-standards.md)
Name the main export for what it does — `runFinalizer(...)` — and name
helpers with a verb describing their body (`commitOwnFileChanges`,
`readGitlinkOid`, `topologicallySortChildFirst`). No `_`-prefixed namespacing
convention is established by the listed primitives (`substituteGitlink`,
`takeSnapshot`, etc. are plain verbs), so match that plain style rather than
inventing a `runFinalizer_*` prefix.

## Constraints checklist (verify against the diff before calling this done)
- No empty commits: `commitOwnFileChanges` returns the unchanged tip when
  `changes.length === 0`; the assembly bump loop skips unchanged gitlinks.
- Own-file commits never touch gitlinks: enforced by only staging the
  specific non-gitlink paths named in `approvedOwnFileChanges`, plus the
  defensive assert in Step 2a.
- No base ref is ever written: only `refs/finalize/<runId>/...` refs are
  created; `currentTipOid`/`recordedBaseOid` are read once as oids, never
  as refs the module writes back to.
- No push: the module never shells out to `git push`.
- New module only: no edits to any existing file, no new call site wiring
  this into another script.
