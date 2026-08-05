# Task 49 Plan: Drive mergeTaskWorktrees through the finalization and publication pipeline

## Conclusion

Task 49 cannot be implemented within its owned files
(`scripts/mergeTaskWorktrees.ts`, `tests/mergeTaskWorktrees.test.ts`) under
the CLI contract the brief fixes (flat `WorkflowArguments` JSON in, unchanged
`{ merged, conflicts }` stdout out, no new argv[2] fields). This is not a
missing-detail problem that more planning can close — it is a hard shape and
authorization mismatch between what `WorkflowArguments`/`CliInput` carries
today and what all five pipeline functions require as arguments. The
evidence below comes from reading all five pipeline scripts in full, plus
every type/module they import from.

## Evidence

### 1. All five entry points are gated by a `RunAuthorizationToken`, and that token cannot be honestly minted from inside `mergeTaskWorktrees.ts`

- `runFinalizer(input, token: RunAuthorizationToken, currentStateDigest: string)`
  (`scripts/runFinalizer.ts`)
- `consolidateRun(runId, logicalRepositories, token: RunAuthorizationToken, currentStateDigest: string)`
  (`scripts/runConsolidation.ts`)
- `pushOperationBranches(input, token: RunAuthorizationToken, currentStateDigest: string)`
  (`scripts/operationPush.ts`)
- `publishBases(repos, approvalState: RunState, rootIntegration)` (`scripts/basePublication.ts`)
  calls `revalidateApprovalInputs` → `checkAuthorizationDrift(approvalState)`,
  which requires a `RunState` carrying a live `authorization`.

`RunAuthorizationToken` (`scripts/runAuthorization.ts`) is a branded type:
the only way to produce one is `issueRunAuthorization(stateDigest)`, and the
only sanctioned caller of that is `issueApprovalAuthorization(runState)` in
`scripts/approvalGate.ts`, which itself requires `runState.approval` to
already be set by `recordApproval(runState)`, which itself requires
`runState.readyForApproval === true` and a `digestInput: ApprovalDigestInput`
of:

```
{ manifest: RepositoryManifest, files: string[], operationRef: string,
  baseRef: string, occurrenceDigests: string[], testReceipts: TestReceipt[],
  reviewHandoffs: string[] }
```

None of `manifest`, `operationRef`, `occurrenceDigests`, `testReceipts`, or
`reviewHandoffs` exist anywhere on `WorkflowArguments` or `CliInput` today,
and the brief forbids adding fields to the CLI's front door ("the script
keeps its current front door... a graph-shaped front door is a later
follow-up"). The only alternative is calling `issueRunAuthorization` directly
inside `mergeTaskWorktrees.ts`, skipping `recordApproval`/
`issueApprovalAuthorization` entirely — that would auto-approve every run
unconditionally, defeating the approval gate `approvalGate.ts` exists to
enforce. That is a real architectural decision (whether this CLI path is
exempt from the approval gate at all) that the brief never makes and a plan
cannot make on its own.

### 2. `runFinalizer` needs occurrence-graph and file-change data `WorkflowArguments` does not carry

`OccurrenceFinalizationInput` requires, per occurrence: `currentTipOid`,
`recordedBaseOid`, `approvedOwnFileChanges: Change[]`, and
`directChildEdges: ChildOccurrenceEdge[]`.

- `Change[]` comes from `diffSnapshots(occurrenceRoot, before, after)` in
  `scripts/ownershipSnapshots.ts`, which requires taking a filesystem
  snapshot (`takeSnapshot`) before and after the work happened, then usually
  running it through `checkOwnership`/`checkGroupBoundary` against
  `OwnershipEffects[]` (from `scripts/ownershipKeys.ts`, not even part of
  this file's current imports). `mergeTaskWorktrees.ts` never takes
  before/after snapshots today — it only runs `git merge --no-ff` between
  two branches.
- `directChildEdges` requires knowing each occurrence's real parent/child
  structure. `WorkflowArguments.repositorySources` is `{ path: string,
  sourceBranch: string }[]` — no `occurrenceId`, `parentOccurrenceId`,
  `childOccurrenceIds`, `gitlinkOid`, or `depth`, all of which
  `RepositoryOccurrence` (`scripts/repositoryManifest.ts`) requires and which
  `runFinalizer`'s topological sort depends on.

### 3. `basePublication.ts` and `logicalRepository.ts` export two different, incompatible types both named `LogicalRepository`

- `scripts/logicalRepository.ts`'s `LogicalRepository`:
  `{ normalizedIdentity, occurrenceIds, selectedBaseOccurrenceId,
  canonicalOccurrenceId, lastWriterOccurrenceId, convergenceDigest,
  consolidationState }` — this is what `operationPush.ts`'s
  `OperationPushInput.logicalRepositories` expects.
- `scripts/basePublication.ts`'s own `LogicalRepository`:
  `{ name, canonicalOccurrencePath, canonicalRefName, otherOccurrences,
  recordedBaseOid, targetOid }` — structurally unrelated to the one above,
  despite the identical name, and this is what `publishBases(repos, ...)`
  expects.

A translation layer inside `mergeTaskWorktrees.ts` would need to build both
shapes from the same flat `WorkflowArguments`, with no brief guidance on
which fields (`name` vs `normalizedIdentity`, `canonicalRefName` vs
`canonicalOccurrenceId`, etc.) correspond to what `mergeTaskWorktrees.ts`
currently tracks (`repo`, `groups[].branch`, `repositorySources[].path`).
That mapping does not exist today even conceptually — group branches are
per-task-group scratch branches (`task-group-N`), not per-logical-repository
canonical/operation branches.

### 4. `taskArchival.ts` needs per-repo publish outcomes `WorkflowArguments` cannot supply

`archivePublishedTasks` consumes `TaskMergeResult[]`, built from
`RawTaskRepoOutcome[]` = `{ taskNumber, repo: { repoName, status, commitHash? } }`.
`PreparedTask` (`scripts/prepareTasks.ts`) is `{ number, briefFile, planFile,
files }` — it has no `repoName` and no per-repo status/commit tracking, and
a single task's `files` can span the parent repo and multiple submodules
with no existing mapping from "task" to "which of N repos published it."

## Why this rules out a fix within the owned files

Every option that would close these gaps requires one of:

- Extending `WorkflowArguments`'s shape (manifest, occurrence graph,
  approval/test-receipt data, per-repo publish outcomes) — explicitly
  disallowed by the brief's "front door is unchanged" / "graph-shaped front
  door is a later follow-up" constraint.
- Bypassing `approvalGate.ts`'s recorded-approval flow and minting a
  `RunAuthorizationToken` unconditionally inside `mergeTaskWorktrees.ts` —
  an unauthorized change to what the approval gate protects, not a
  translation detail.
- Editing the five pipeline scripts (or their upstream types) to accept a
  simpler, `mergeTaskWorktrees`-shaped input — out of scope for task 49,
  whose owned files are only `scripts/mergeTaskWorktrees.ts` and
  `tests/mergeTaskWorktrees.test.ts`.

None of these are decisions a plan is entitled to make unilaterally, and
none can be executed without touching files outside task 49's ownership (or
data the CLI contract forbids adding). Task 49 as scoped by the brief is not
implementable; it needs to go back for re-scoping (e.g. splitting out a
prerequisite task that either changes the CLI contract or adds the
approval/manifest plumbing `mergeTaskWorktrees.ts` would need to call these
five scripts safely).
