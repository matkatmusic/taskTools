# Task 26 Plan: scripts/runConsolidation.ts

## Scope

New files only:
- `scripts/runConsolidation.ts`
- `tests/runConsolidation.test.ts`

Do not touch `scripts/repositoryIntegration.ts`, `scripts/runFinalizer.ts`,
`scripts/logicalRepository.ts`, `scripts/occurrenceBranchNames.ts`,
`scripts/syncReceipts.ts`, or `scripts/runAuthorization.ts`. Import from them,
don't edit them. Before wiring any call into those modules, open each one and
read its exact exported signature — the brief only gave partial shapes, and
this plan's function names for calls into those modules (e.g. the digest
check on `RunAuthorizationToken`, the exact export from
`occurrenceBranchNames.ts`) must be matched to what's actually exported, not
guessed.

Before writing test fixture helpers (spinning up a scratch git repo, making
commits, branches), grep `tests/` for an existing git-repo-fixture builder
(there is likely one already backing tests for `prepareNoFfMerge` in
`repositoryIntegration.ts`, since that's the same kind of merge-commit
plumbing). Reuse it. Only write new fixture code if nothing like it exists.

No remote pushes, no `baseBranch` ref updates, no task-archival calls
anywhere in this module — this is Phase 3, publishing stays disabled.

## Why this shape (read before objecting to any one piece)

The brief describes two ref-mutating outcomes (name the operation branch,
fast-forward occurrence branches) and two abort outcomes (tree mismatch,
merge conflict) that must **preserve every ref**. The only way to guarantee
"preserve every ref on abort" without undo logic is: do every merge and every
tree check as **pure computation** first (via `prepareNoFfMerge`, which the
brief confirms moves no ref), and only touch real refs after every check has
already passed. So the implementation order below is: fold all merges
in-memory → verify tree → prepare the integration merge in-memory → *then*,
and only then, write the two kinds of real refs. If any computation step
fails, return immediately — nothing has been written, so "preserved" is
simply true by construction, not something to engineer separately.

"Exactly one prepared integration OID per logical repository" falls out of
the same structure: all participating branches fold into a single assembly
commit first, and `prepareNoFfMerge` is called exactly once per logical
repository (base → assembly tip), never once per group.

## Data shapes (define locally in runConsolidation.ts)

```ts
interface GroupOccurrenceBranch {
    groupId: string;
    occurrencePath: string;
    occurrenceId: string;
    branchOid: string;
    sourceRepoRoot: string;
}

interface LogicalRepositoryConsolidationInput {
    logicalRepositoryId: string;
    canonicalRepoRoot: string;
    canonicalOccurrenceBranchName: string;
    participatingBranches: GroupOccurrenceBranch[];
    approvedConvergedTreeOid: string;
    finalizedChildGitlinks: GitlinkChainLink[];
    recordedBaseOid: string;
    baseBranchRef: string;
}

interface FastForwardedBranch {
    occurrenceId: string;
    branchRef: string;
    oid: string;
}

interface RunConsolidationSuccess {
    logicalRepositoryId: string;
    operationBranchRef: string;
    operationOid: string;
    fastForwardedOccurrenceBranches: FastForwardedBranch[];
    preparedIntegrationOid: string;
}

interface RunConsolidationAbort {
    logicalRepositoryId: string;
    aborted: {
        reason: "conflict" | "tree-mismatch";
        conflicts?: RepositoryQualifiedConflict[];
        preservedRefs: string[];
    };
}

type RunConsolidationResult = RunConsolidationSuccess | RunConsolidationAbort;
```

`canonicalOccurrenceBranchName` is precomputed by the caller via
`occurrenceBranchNames(...)` for the `lastWriterOccurrence` — the brief
requires "retaining its path-suffixed branch name" for a repeated logical
repository, and that name is exactly what `occurrenceBranchNames` already
produces. Don't reformat or re-derive a branch name inside this module;
accept it as an input string.

`finalizedChildGitlinks` are the `finalizedIntegrationOid` values collected
across the relevant `OccurrenceFinalizationResult` entries from
`runFinalizer`'s output, shaped as whatever `GitlinkChainLink` requires — take
them as an input array, don't call `runFinalizer` from inside this module.

`ConsolidationState` / `buildLogicalRepositories` from `logicalRepository.ts`
are not required by this design — `LogicalRepositoryConsolidationInput`
already carries everything this module needs per logical repository. Only
reach for them if, once you're inside the code, `logicalRepositoryId` alone
turns out to be insufficient to identify participating branches — check
`logicalRepository.ts` before adding it as a dependency.

## Functions to write, in build order

1. `runGit(repoRoot: string, args: string[]): string` — thin `execFileSync`
   wrapper (trim stdout). Only add this if `repositoryIntegration.ts` doesn't
   already export something equivalent; if it does, import that instead of
   writing a second one.

2. `sortParticipatingBranches(branches: GroupOccurrenceBranch[]): GroupOccurrenceBranch[]`
   — stable sort by `groupId` ascending, then `occurrencePath` ascending.
   This is the entire "merge order is deterministic" guarantee: callers may
   pass branches in any order, this function always normalizes it before any
   merge happens.

3. `fetchBranchIntoCanonicalRepo(canonicalRepoRoot: string, branch: GroupOccurrenceBranch): void`
   — no-op when `branch.sourceRepoRoot === canonicalRepoRoot` (the common
   case in tests, where everything lives in one fixture repo already).
   Otherwise `git -C canonicalRepoRoot fetch <sourceRepoRoot> <branchOid>`.

4. `foldMergeParticipatingBranches(canonicalRepoRoot: string, sorted: GroupOccurrenceBranch[], runId: string): { merged: true; assemblyOid: string } | { merged: false; conflict: RepositoryQualifiedConflict }`
   — seed `assemblyOid` with `sorted[0].branchOid`, then for each remaining
   branch call `fetchBranchIntoCanonicalRepo` followed by
   `prepareNoFfMerge(canonicalRepoRoot, assemblyOid, branch.branchOid, message)`.
   On the first `merged: false`, return it immediately (stop folding — no
   refs have been touched yet, nothing to unwind). On success, `assemblyOid`
   becomes the running result, fed into the next fold step.

5. `getTreeOidForCommit(repoRoot: string, commitOid: string): string` —
   `git rev-parse ${commitOid}^{tree}` via `runGit`.

6. `computeExpectedTreeOid(approvedConvergedTreeOid: string, finalizedChildGitlinks: GitlinkChainLink[]): string`
   — call `substituteGitlinksRecursively(approvedConvergedTreeOid, finalizedChildGitlinks)`
   from `repositoryIntegration.ts`. Don't reimplement gitlink substitution.

7. `buildOperationBranchRef(runId: string, canonicalOccurrenceBranchName: string): string`
   — `refs/heads/operations/${runId}/${canonicalOccurrenceBranchName}`. Fixed
   template, no config knob — this is an internal, single-purpose naming
   scheme, not a public convention that needs to flex.

8. `moveRefFastForward(repoRoot: string, refName: string, newOid: string, expectedOldOid?: string): void`
   — `git -C repoRoot update-ref <refName> <newOid> [<expectedOldOid>]`. Pass
   `expectedOldOid` for occurrence-branch fast-forwards (compare-and-swap
   against the branch's known tip, so a concurrent mutation elsewhere is
   caught by git itself rather than silently overwritten); omit it when
   creating the operation branch ref for the first time (it doesn't exist
   yet, nothing to CAS against).

9. `consolidateLogicalRepository(input: LogicalRepositoryConsolidationInput, runId: string): RunConsolidationResult`
   — orchestrates 2–8 in this exact order:
   a. `sortParticipatingBranches`
   b. `foldMergeParticipatingBranches` → on conflict, return
      `{ logicalRepositoryId, aborted: { reason: "conflict", conflicts: [conflict], preservedRefs: [input.baseBranchRef, ...input.participatingBranches.map(b => branch ref name)] } }`.
      (Preserved-refs list is informational/testable — nothing in it was
      ever written to.)
   c. `getTreeOidForCommit(assemblyOid)` vs `computeExpectedTreeOid(...)` —
      on mismatch, return `{ logicalRepositoryId, aborted: { reason: "tree-mismatch", preservedRefs: [...] } }` (no `conflicts` field).
   d. `prepareNoFfMerge(canonicalRepoRoot, input.recordedBaseOid, assemblyOid, message)`
      — this is the *one* real integration prepare call for this logical
      repository. On `merged: false`, return the same conflict-shaped abort
      as (b), still before touching any ref.
   e. Only now, mutate real refs:
      - `moveRefFastForward` (no old-oid check) to create
        `operationBranchRef` at `assemblyOid`.
      - For each participating branch, `moveRefFastForward` its branch ref
        to `assemblyOid` with `expectedOldOid: branch.branchOid`.
      - Do not touch `input.baseBranchRef` — leave it exactly where it was;
        this is the "without moving baseBranch" requirement.
   f. Return `{ logicalRepositoryId, operationBranchRef, operationOid: assemblyOid, fastForwardedOccurrenceBranches, preparedIntegrationOid: integrationResult.commitOid }`.

10. `validateRunAuthorization(token: RunAuthorizationToken, currentStateDigest: string): void`
    — call the existing digest-check export from `runAuthorization.ts` (name
    TBD from reading that file); follow its existing throw/return
    convention rather than inventing a new error shape here.

11. `consolidateRun(runId: string, logicalRepositories: LogicalRepositoryConsolidationInput[], token: RunAuthorizationToken, currentStateDigest: string): RunConsolidationResult[]`
    — call `validateRunAuthorization` once up front (fail the whole run on a
    bad token/digest — this is an authorization violation, not a per-repo
    business conflict, so it's the one case that *does* short-circuit
    everything). Then map `consolidateLogicalRepository` over
    `logicalRepositories`, one call per logical repository, independently —
    a conflict or tree-mismatch in one logical repository must not block or
    roll back any other logical repository's result, since they're
    different repos with no shared ref state.

## Test plan — tests/runConsolidation.test.ts

Match whatever test framework/style `tests/relatedTests.test.ts` already
uses (open it first) rather than assuming one. Each test below is one
behavior, matching the brief's five required tests one-to-one.

1. **Two disjoint groups become ancestors of one operation branch.**
   Fixture: one repo, two branches (`groupA`, `groupB`) with disjoint file
   edits off a common base, no conflict. Compute the real expected merged
   tree ahead of time (a throwaway `git merge-tree` in test setup) and feed
   it in as `approvedConvergedTreeOid` with `finalizedChildGitlinks: []`.
   Call `consolidateLogicalRepository`. Assert success (no `aborted`), then
   assert `git merge-base --is-ancestor groupA.branchOid operationOid` and
   the same for `groupB.branchOid` both exit 0.

2. **Merge order is deterministic.** Same fixture as (1). Call
   `consolidateLogicalRepository` twice, once with `participatingBranches`
   as `[groupA, groupB]` and once as `[groupB, groupA]`. Assert both calls
   return the identical `operationOid` — proves the function sorts
   internally rather than trusting caller order.

3. **Tree mismatch aborts with every ref preserved.** Same fixture as (1),
   but pass a wrong `approvedConvergedTreeOid` (any unrelated tree oid in
   the same repo). Assert result is `{ aborted: { reason: "tree-mismatch" } }`.
   Assert `git show-ref --verify <operationBranchRef>` fails (never
   created) and each occurrence branch ref still resolves to its original
   `branchOid` (unchanged).

4. **A conflict returns repository-qualified results and leaves base refs
   untouched.** Fixture: two branches editing the same line differently, so
   `foldMergeParticipatingBranches` hits a real conflict. Assert result is
   `{ aborted: { reason: "conflict", conflicts: [{ repoRoot, conflictedPaths }] } }`
   with a non-empty `conflictedPaths`. Assert `git rev-parse <baseBranchRef>`
   still equals `recordedBaseOid` (untouched) and `operationBranchRef` was
   never created.

5. **Exactly one prepared integration OID per logical repository.** Build
   two `LogicalRepositoryConsolidationInput` entries (two separate logical
   repositories, each with its own two-branch disjoint-merge fixture from
   (1)) and call `consolidateRun`. Assert the returned array has exactly one
   result per logical repository, each a `RunConsolidationSuccess` with a
   single `preparedIntegrationOid` string (not an array), and that the two
   `preparedIntegrationOid` values are distinct — proving one prepare per
   logical repository, not one per group.

## Order to implement (red/green per guide)

Write test 1 first (red), then functions 1–9 (green) — this is the
straight-line success path and forces every non-abort function into
existence. Then test 2 (red/green — should already pass once (2) sorts
internally; if it doesn't, that's the fix). Then test 3, then test 4 (each
red against the already-built success path, green once the corresponding
abort branch in step 9 is wired). Then test 5 exercises `consolidateRun`
(10, 11) last, since it's the thinnest orchestration layer over what's
already proven per-repository.
