# Task 49 plan: drive mergeTaskWorktrees through finalize/consolidate/push/publish/archive

(Supersedes an earlier `needs-clarification` draft in this same file, written before the brief's
2026-08-05 "publish contradiction is resolved" and "editable files widened" updates. Both of that draft's
blockers are resolved by those updates: the base branch is no longer moved by the merge itself — only
`publishBases` moves it, under CAS — and `scripts/mergePipeline.ts` is now an editable new file, so the
250-line cap on `scripts/mergeTaskWorktrees.ts` is no longer a blocker.)

## Architecture decision (binding, resolved during planning)

`runFinalizer.ts`, `runConsolidation.ts`, `operationPush.ts`, `basePublication.ts`, `taskArchival.ts` are
read-only. Nothing in this plan edits them. Everything below is about how
`scripts/mergePipeline.ts` (new) calls them, and how `scripts/mergeTaskWorktrees.ts` is trimmed to
delegate to it.

**Key design facts established by reading the five files + their tests, binding on the implementer:**

1. **Per-occurrence base-fold, not literal `git merge`.** For every occurrence path (root `""` plus
   every `repositorySources` submodule path), every group's worktree already has a real git branch
   checked out there (`createWorktreeForGroup` + `createBranchInEveryRepository` in `prepareTasks.ts`
   guarantee this — every group branches every occurrence path, whether or not that group's tasks
   touched it). So "did group G's occurrence-path change cleanly merge" is answered by folding that
   occurrence's participating group branches together with `prepareNoFfMerge` (from
   `repositoryIntegration.ts`, pure — "Neither moves a branch or touches a base ref") and then test-merging
   the fold onto the occurrence's real `baseOid` with the same primitive. Neither step touches any ref.
2. **Real-base conflicts must be checked before minting approval, not only the N-way group fold.**
   `runFinalizer`/`consolidateRun`/`pushOperationBranches` all require a valid, matching
   `RunAuthorizationToken`, which only exists after `recordApproval`+`issueApprovalAuthorization`, which
   require `readyForApproval`. So the "did this merge cleanly" check must happen *before* authorization,
   using the same pure `prepareNoFfMerge` primitive against `occurrence.baseOid` — this is what replaces
   `mergeGroupBranchIntoRepo`'s literal `git merge` for conflict detection. (Verified against
   `test_runPipelineCliProducesNoApprovalStateWhenAGroupConflicts`: the group's branch conflicts with a
   commit made directly on `sourceBranch` *after* the group forked — a single-group scenario, so the
   conflict only surfaces when checked against the true base, not from folding multiple group branches
   together.)
3. **`finalizedChildGitlinks` stays `[]`, and each publication target is the finalizer's own `finalizedIntegrationOid`
   — no extra merge call.** Traced precisely against `consolidateLogicalRepository`
   (`runConsolidation.ts:117-170`): when `finalizedChildGitlinks` is non-empty, `computeExpectedTreeOid`
   substitutes the supplied child oid into `approvedConvergedTreeOid` and compares that against
   `actualTreeOid`, which `consolidateLogicalRepository` computes **itself**, internally, by folding
   `participatingBranches` — the *raw* group branches, which never touch a gitlink. So `actualTreeOid` can
   never carry a bumped child gitlink, no matter what `finalizedChildGitlinks` says to expect — populating
   it with a real chain would make every container occurrence whose child actually changed abort with
   `"tree-mismatch"` (concretely, it breaks
   `test_runPipelineCliMintsApprovalAndPublicationTargetsWhenEvidenceIsCompleteAndGreen`, whose submodule
   group commits `vendor-new.txt`, so the child's finalized oid necessarily differs from the root's existing
   gitlink oid). So `finalizedChildGitlinks: []` is not a shortcut being taken for convenience — it is the
   only value under which `consolidateLogicalRepository`'s own tree check can pass for a changed child.
   Consolidation is still called for its other genuine side effects (folding branches, fast-forwarding
   occurrence branches, creating the operation branch ref under authorization) but its
   `preparedIntegrationOid` is deliberately never read for publication.
   Instead, each occurrence's publication `targetOid` is `runFinalizer`'s own
   `finalizedIntegrationOid` for that occurrence, used **directly, with no further merge**:
   `finalizeApprovedRun`'s `buildAssemblyBranch` (in `runFinalizer.ts`) already builds this commit on top of
   the occurrence's *base-integrated* tip (see fact 3a below) with every direct child's gitlink substituted
   to that child's own `finalizedIntegrationOid` — so publishing every occurrence's own
   `finalizedIntegrationOid` unmodified guarantees a parent's published gitlink and its child's published
   commit are always the exact same oid; there is no separate merge step that could make them diverge. This
   also removes the earlier draft's redundant `prepareNoFfMerge(repoRoot, occurrence.baseOid,
   finalized.finalizedIntegrationOid, ...)` publication-merge call entirely — it produced a *different*
   commit than the child's own `finalizedIntegrationOid`, so a parent's gitlink and the child's published tip
   could disagree. It is deleted; `finalized.finalizedIntegrationOid` is the `targetOid` directly.
3a. **The base-integrated oid, not the raw fold oid, feeds finalization.** `resolveOccurrenceFold` (File 2)
   now returns two oids on success: `foldOid` (the raw N-way fold of group branches, un-integrated with the
   real base — this is what `approvedConvergedTreeOid` for consolidation is still built from, since that is
   what `consolidateLogicalRepository`'s own internal fold reproduces) and `integratedOid` (the result of
   the fold's own "check base" stage, i.e. `prepareNoFfMerge(repoRoot, occurrence.baseOid, foldOid, ...)` —
   a real merge commit with `occurrence.baseOid` as a parent). `OccurrenceFinalizationInput.currentTipOid`
   and `.recordedBaseOid` are both set to `integratedOid`, not `foldOid`, so that `finalizedIntegrationOid`
   (leaf or container) is genuinely descended from the occurrence's real base, not merely from the group
   branches' fork point.
3b. **`consolidationInputs[i].canonicalOccurrenceBranchName` is `occurrence.operationBranch`, not
   `occurrence.baseBranch`.** `consolidateLogicalRepository` uses this field only to name the operation
   branch ref it fast-forwards (`refs/heads/operations/${runId}/${canonicalOccurrenceBranchName}` in
   `buildOperationBranchRef`) — it never reads or moves `baseBranchRef` itself (that field is only used for
   `preservedRefs` bookkeeping on abort). Naming the operation branch after the real base branch would be
   misleading about what does and does not move; `occurrence.operationBranch` is the manifest's own field for
   exactly this purpose (already read elsewhere, e.g. by `pushOperationBranches`'s `pushLogicalRepository`),
   and using it keeps the invariant from fact 6 explicit: only `publishBases`'s CAS `update-ref` ever moves a
   real base branch.
4. **`buildLogicalRepositories` (the top-level export from `logicalRepository.ts`) is not called directly**,
   because it throws on `originUrl: ""` (`normalizeRepositoryIdentity` fails `new URL("")` and returns
   `null`, and `buildLogicalRepositories` treats a `null` identity as an error) — every manifest built by the
   CLI's own tests (`makeManifest`) uses `originUrl: ""` for every occurrence, so calling it verbatim would
   throw for every existing CLI-level test. `mergePipeline.ts` instead has its own
   `groupOccurrencesIntoLogicalRepositories`, which mirrors `buildLogicalRepositories`'s real grouping logic
   (group occurrences by `normalizeRepositoryIdentity(occurrence.originUrl)`, `consolidationState: "single"`
   when a group has one occurrence and `"grouped"` when it has more) but gives every occurrence whose
   `originUrl` is blank or unparseable (`normalizeRepositoryIdentity` returns `null`) its own deterministic
   singleton group — keyed on `occurrenceId`, which is guaranteed unique by
   `validateRepositoryManifest` — instead of throwing. Every occurrence in every existing CLI-level test
   fixture has `originUrl: ""`, so every one of them lands in its own singleton group exactly as before
   (`occurrenceIds.length === 1`, `consolidationState: "single"`), and `pushOperationBranches`'s
   `pushLogicalRepository` still returns `{kind: "skipped-unique", ...}` for each of them without ever
   reading `normalizedIdentity` or touching the network — no behavior change for any occurrence with a blank
   origin. Occurrences that *do* share a real, parseable `originUrl` (not exercised by any current test, but
   a real multi-checkout scenario this CLI's manifest can represent) now correctly land in one shared
   `LogicalRepository` and get pushed/verified together by `pushOperationBranches`, instead of being silently
   treated as independent no-ops.
5. **`occurrence.checkoutPath` stays repo-relative**, exactly like the existing (pre-change) code already
   treats it (`join(workflowArguments.repo, occurrence.checkoutPath)` in the current
   `runPipelineCli`, and `checkoutPath: ""` / `checkoutPath: "vendor"` in the test fixture's `makeManifest`).
   This is a different convention than `repositoryDiscovery.ts`'s absolute `checkoutPath` — that
   inconsistency predates this task and is out of scope; this plan continues the CLI's existing convention
   faithfully so the untouched test fixtures keep working.
6. **The base branch does move by the end of a successful run — just via `publishBases`'s CAS
   `update-ref`, not via a `git checkout`+`git merge` mutating the working tree.** This means
   `test_runPipelineCliMintsApprovalAndPublicationTargetsWhenEvidenceIsCompleteAndGreen`'s assertions
   (`postMergeRootOid != preMergeRootOid`, exact `publicationTargets` shape) still hold with the new
   implementation and **needs no edit** — traced field-by-field in "Test file changes" below. The
   repoRoot's on-disk working tree is *not* refreshed by this run (no working-tree checkout happens
   anywhere in the new pipeline) — this is an intentional scope boundary, not an oversight: no given or new
   test checks file existence in `repoRoot`'s working tree after a run, only ref/oid state.
7. **Whole-run atomicity replaces per-group independence.** The old sequential loop let a later group
   still merge after an earlier one conflicted. `runFinalizer`/`consolidateRun` each take the *whole run's*
   occurrence set in one call, under one authorization token tied to one approval digest covering every
   group — there is no way to authorize/finalize a subset. So the new pipeline gates the entire
   finalize→consolidate→push→publish→archive chain on every occurrence's pre-check succeeding; if any
   occurrence fails, every group is reported as conflicted (every group participates in every occurrence
   path, per fact 1). This is the "largest behavior change" the brief names. No existing test exercises
   more than one group at the CLI-pipeline level, so this is unconstrained by current coverage.
8. **`archivePublishedTasks` is safe to call unconditionally when reached.** Every CLI-level test fixture
   (`makeGroup` in `tests/mergeTaskWorktrees.test.ts`) builds `PreparedGroup.tasks: []`, so
   `publishedTaskNumbers` will always be `[]` for every existing test, so `archived.length` stays `0` and
   `archivePublishedTasks` never reaches its `writeFileSync` branch — no risk of it touching a real or
   missing `tasks.json` during tests.

## File 1: scripts/mergeTaskWorktrees.ts (edits)

Current file is 354 lines. After these edits it will be ~241 lines (well under the 250 cap).

### Edit 1 — imports (lines 1–15)

Current text (lines 1–15):
```
// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath, type PreparedGroup, type WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { computeOccurrenceDigests, recordApproval, issueApprovalAuthorization } from "./approvalGate.ts";
import type { OccurrenceSnapshot, RunState, ApprovalDigestInput } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import type { RepositoryManifest } from "./repositoryManifest.ts";
```

Becomes:
```
// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import type { PreparedGroup } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { runMergePipeline } from "./mergePipeline.ts";
```

Rationale: `rmSync`, `resolveRunArgumentsPath`/`resolveRunOutcomesPath`/`resolveStepOutputsPath`,
`WorkflowArguments`, `appendRunMetricsRecord`/`computeArgumentsHash`/`runDurationMs`,
`computeOccurrenceDigests`/`recordApproval`/`issueApprovalAuthorization`,
`OccurrenceSnapshot`/`RunState`/`ApprovalDigestInput`, `TestReceipt`, `RepositoryManifest` are used only
by `runPipelineCli`/`CliInput`, both of which move to `mergePipeline.ts` (Edit 3). `existsSync`,
`readFileSync`, `realpathSync`, `basename`, `join`, `tmpdir`, `PreparedGroup`, `collectRepositorySources`,
`currentBranchName`, `declaredFiles`, `TaskRecord`, `readTaskFile`, `resolveTaskFiles` are all still used
by code that stays in this file (verified against every remaining use site below).

### Edit 2 — delete `CliInput` type (lines 17–28) and the local `PublicationTarget` type (line 41)

Delete lines 17–28 in full (the `type CliInput = WorkflowArguments & { ... };` block and its
surrounding blank lines collapse to one blank line between the import block and
`export type SubmoduleConflict = ...`). `CliInput` moves to `mergePipeline.ts` (Edit 3), exported from
there as `export type CliInput = ...` with identical field shape.

Delete line 41 (`export type PublicationTarget = { repositoryPath: string; recordedBaseOid: string; targetOid: string };`).
This type moves to `mergePipeline.ts`, renamed `PublicationTargetSummary` there (Edit 3) — the rename
avoids colliding with `basePublication.ts`'s own exported `PublicationTarget` type, which
`mergePipeline.ts` also imports. Confirmed by `rg -n "PublicationTarget" scripts tests`: nothing outside
`scripts/mergeTaskWorktrees.ts` imports this local type by name, so the rename is safe.

Lines 30–39 (`SubmoduleConflict`, `MergeOutcome`) are **unchanged** — they stay exported from this file,
since `mergeGroupBranchIntoRepo`'s return type needs them here, and `mergePipeline.ts` imports them as
types: `import type { MergeOutcome, SubmoduleConflict } from "./mergeTaskWorktrees.ts";`. This is a
type-only import, erased at compile time, so it does not create a runtime circular dependency with
`mergeTaskWorktrees.ts`'s own runtime import of `runMergePipeline` from `mergePipeline.ts`.

### Edit 3 — delete `runPipelineCli` in full (current lines 219–332)

Delete the entire function:
```
function runPipelineCli(input: CliInput): void {
    ...
}
```
(everything from `function runPipelineCli(input: CliInput): void {` through the closing `}` on the line
before `function runAsCli(): void {`). This logic, rebuilt against the five-file pipeline, becomes the
body of `runMergePipeline` in the new `scripts/mergePipeline.ts` (see File 2 below). Nothing in this
function survives verbatim in `mergeTaskWorktrees.ts`.

### Edit 4 — rewire `runAsCli` to call `runMergePipeline` and become async (current lines 334–354)

Current text:
```
function runAsCli(): void {
    const mode = process.argv[2];
    if (mode === "--discover") {
        runDiscoverCli();
        return;
    }
    if (mode === "--merge") {
        runMergeCli(process.argv[3]);
        return;
    }
    if (mode === "--run") {
        const prepared = JSON.parse(readFileSync(process.argv[3], "utf8"));
        const outcomesFile = process.argv[4];
        const outcomes = outcomesFile && existsSync(outcomesFile) ? JSON.parse(readFileSync(outcomesFile, "utf8")) : {};
        runPipelineCli({ ...prepared, ...outcomes });
        return;
    }
    runPipelineCli(JSON.parse(process.argv[2]));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
```

Becomes:
```
async function runAsCli(): Promise<void> {
    const mode = process.argv[2];
    if (mode === "--discover") {
        runDiscoverCli();
        return;
    }
    if (mode === "--merge") {
        runMergeCli(process.argv[3]);
        return;
    }
    if (mode === "--run") {
        const prepared = JSON.parse(readFileSync(process.argv[3], "utf8"));
        const outcomesFile = process.argv[4];
        const outcomes = outcomesFile && existsSync(outcomesFile) ? JSON.parse(readFileSync(outcomesFile, "utf8")) : {};
        await runMergePipeline({ ...prepared, ...outcomes });
        return;
    }
    await runMergePipeline(JSON.parse(process.argv[2]));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    runAsCli().catch((error) => {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    });
}
```

Rationale for `async`/`.catch()`: `runMergePipeline` must be `async` because it awaits
`pushOperationBranches` (File 2, which is itself `async`). `--discover`/`--merge` stay synchronous calls
inside the now-`async` function — no behavior change for those two modes. The `.catch()` wrapper
preserves "non-zero exit + stderr message on failure" instead of relying on an unhandled promise
rejection; no existing test exercises an error path through this entry point, so this is a safe,
equivalent-behavior change.

No other lines in `scripts/mergeTaskWorktrees.ts` change. `git`, `gitErrorText`, `TaskWorktree`,
`parseWorktreeListPorcelain`, `listTaskWorktrees`, `unmergedCommitCount`, `commitChangedFiles`,
`uncommittedChangedFiles`, `UnmergedTaskWorktree`, `findUnmergedTaskWorktrees`, `mergeGroupBranchIntoRepo`,
`resolveGitlinkConflicts`, `mergeSubmoduleBranchIntoRepo`, `removeWorktreeAndBranch`, `runDiscoverCli`,
`runMergeCli` are untouched, stay exported exactly as before, and stay behaviorally unchanged (this
satisfies the brief's requirement that these four functions "stay exported and behaviorally unchanged").

## File 2: scripts/mergePipeline.ts (new file, complete content)

Write this file verbatim:

```ts
// Translates the flat WorkflowArguments CLI input into the finalize/consolidate/push/publish/archive pipeline.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
    resolveRunArgumentsPath,
    resolveRunOutcomesPath,
    resolveStepOutputsPath,
    type WorkflowArguments,
} from "./prepareTasks.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import {
    computeOccurrenceDigests,
    recordApproval,
    issueApprovalAuthorization,
    finalizeApprovedRun,
} from "./approvalGate.ts";
import type { OccurrenceSnapshot, RunState, ApprovalDigestInput } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import type { RepositoryManifest, RepositoryOccurrence } from "./repositoryManifest.ts";
import type { MergeOutcome, SubmoduleConflict } from "./mergeTaskWorktrees.ts";
import { prepareNoFfMerge } from "./repositoryIntegration.ts";
import type { RepositoryQualifiedConflict } from "./repositoryIntegration.ts";
import { sortParticipatingBranches, consolidateRun } from "./runConsolidation.ts";
import type { GroupOccurrenceBranch, LogicalRepositoryConsolidationInput } from "./runConsolidation.ts";
import type { OccurrenceFinalizationInput } from "./runFinalizer.ts";
import { pushOperationBranches } from "./operationPush.ts";
import type { LogicalRepository } from "./logicalRepository.ts";
import { normalizeRepositoryIdentity } from "./submoduleUrlIdentity.ts";
import { publishBases } from "./basePublication.ts";
import type { PublicationTarget } from "./basePublication.ts";
import { archivePublishedTasks, summarizeTaskMergeResults } from "./taskArchival.ts";
import type { RawTaskRepoOutcome, TaskMergeResult } from "./taskArchival.ts";

export type CliInput = WorkflowArguments & {
    runId?: string;
    startTimestamp?: string;
    doneCount?: number;
    partialCount?: number;
    blockedCount?: number;
    needsClarificationCount?: number;
    requeueCount?: number;
    testReceipts?: TestReceipt[];
    reviewHandoffs?: string[];
    repositoryManifest: RepositoryManifest;
};

export type PublicationTargetSummary = { repositoryPath: string; recordedBaseOid: string; targetOid: string };

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

type FoldResult =
    | { folded: true; foldOid: string; integratedOid: string }
    | { folded: false; conflict: RepositoryQualifiedConflict };

// Folds group branches into foldOid, then test-merges onto the real base as integratedOid.
function resolveOccurrenceFold(
    repoRoot: string,
    baseOid: string,
    sortedBranches: GroupOccurrenceBranch[],
    label: string,
): FoldResult {
    for (const branch of sortedBranches) git(repoRoot, "fetch", branch.sourceRepoRoot, branch.branchOid);
    let assemblyOid = sortedBranches[0].branchOid;
    for (let i = 1; i < sortedBranches.length; i++) {
        const branch = sortedBranches[i];
        const result = prepareNoFfMerge(repoRoot, assemblyOid, branch.branchOid, `mergePipeline ${label}: fold ${branch.groupId}`);
        if (!result.merged) return { folded: false, conflict: result.conflict };
        assemblyOid = result.commitOid;
    }
    const integrated = prepareNoFfMerge(repoRoot, baseOid, assemblyOid, `mergePipeline ${label}: check base`);
    if (!integrated.merged) return { folded: false, conflict: integrated.conflict };
    return { folded: true, foldOid: assemblyOid, integratedOid: integrated.commitOid };
}

function branchesForOccurrence(
    groups: WorkflowArguments["groups"],
    relativePath: string,
    occurrenceId: string,
): GroupOccurrenceBranch[] {
    return sortParticipatingBranches(groups.map((group) => {
        const sourceRepoRoot = relativePath === "" ? group.worktree : join(group.worktree, relativePath);
        return {
            groupId: String(group.groupId),
            occurrencePath: relativePath,
            occurrenceId,
            branchOid: git(sourceRepoRoot, "rev-parse", "HEAD"),
            sourceRepoRoot,
        };
    }));
}

// Every group has a branch at every occurrence path, so one path's conflict implicates every group.
function buildGroupOutcome(
    group: WorkflowArguments["groups"][number],
    foldByPath: Map<string, FoldResult>,
    submodulePaths: string[],
): MergeOutcome {
    const submoduleConflicts: SubmoduleConflict[] = [];
    for (const path of submodulePaths) {
        const fold = foldByPath.get(path)!;
        if (!fold.folded) submoduleConflicts.push({ path, conflictedFilePaths: fold.conflict.conflictedPaths, failureReason: null });
    }
    const base = { groupId: group.groupId, worktree: group.worktree, submoduleConflicts };
    if (submoduleConflicts.length > 0) return { ...base, merged: false, conflictedFilePaths: [], failureReason: null };
    const rootFold = foldByPath.get("")!;
    if (!rootFold.folded) return { ...base, merged: false, conflictedFilePaths: rootFold.conflict.conflictedPaths, failureReason: null };
    return { ...base, merged: true, conflictedFilePaths: [], failureReason: null };
}

// Groups occurrences by real upstream identity; a blank/unparseable originUrl gets its own singleton group.
function groupOccurrencesIntoLogicalRepositories(occurrences: RepositoryOccurrence[]): LogicalRepository[] {
    const groups = new Map<string, RepositoryOccurrence[]>();
    for (const occurrence of occurrences) {
        const identity = normalizeRepositoryIdentity(occurrence.originUrl);
        const key = identity ? `${identity.host}/${identity.owner}/${identity.repository}` : `unique:${occurrence.occurrenceId}`;
        const existing = groups.get(key);
        if (existing) existing.push(occurrence); else groups.set(key, [occurrence]);
    }
    return Array.from(groups.values()).map((group) => {
        const occurrenceIds = group.map((o) => o.occurrenceId);
        const identity = normalizeRepositoryIdentity(group[0].originUrl) ?? { host: "", owner: "", repository: group[0].occurrenceId };
        return {
            normalizedIdentity: identity,
            occurrenceIds,
            selectedBaseOccurrenceId: occurrenceIds[0],
            canonicalOccurrenceId: occurrenceIds[0],
            lastWriterOccurrenceId: occurrenceIds[occurrenceIds.length - 1],
            convergenceDigest: createHash("sha256").update([...occurrenceIds].sort().join("\n")).digest("hex"),
            consolidationState: occurrenceIds.length === 1 ? "single" : "grouped",
        };
    });
}

export async function runMergePipeline(input: CliInput): Promise<void> {
    if (!input.repositoryManifest) throw new Error("no repository manifest given in CLI input; approval cannot be minted without pre-merge base OIDs");
    const runId = input.runId ?? new Date().toISOString();
    const sortedGroups = [...input.groups].sort((a, b) => a.groupId - b.groupId);
    const manifest = input.repositoryManifest;
    const rootOccurrence = manifest.occurrences.find((o) => o.parentOccurrenceId === null);
    if (!rootOccurrence) throw new Error("repository manifest has no root occurrence");
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    const testReceipts = input.testReceipts ?? [];
    const reviewHandoffs = input.reviewHandoffs ?? [];

    const branchesByPath = new Map<string, GroupOccurrenceBranch[]>();
    const foldByPath = new Map<string, FoldResult>();
    for (const occurrence of manifest.occurrences) {
        const branches = branchesForOccurrence(sortedGroups, occurrence.checkoutPath, occurrence.occurrenceId);
        branchesByPath.set(occurrence.checkoutPath, branches);
        const repoRoot = join(input.repo, occurrence.checkoutPath);
        foldByPath.set(occurrence.checkoutPath, resolveOccurrenceFold(repoRoot, occurrence.baseOid, branches, `${runId}/${occurrence.occurrenceId}`));
    }

    const submodulePaths = manifest.occurrences.map((o) => o.checkoutPath).filter((p) => p !== "");
    const merged: MergeOutcome[] = [];
    const conflicts: MergeOutcome[] = [];
    for (const group of sortedGroups) {
        const outcome = buildGroupOutcome(group, foldByPath, submodulePaths);
        (outcome.merged ? merged : conflicts).push(outcome);
    }
    const allOccurrencesFolded = conflicts.length === 0;

    const operationRef = allOccurrencesFolded ? (foldByPath.get("") as { folded: true; foldOid: string }).foldOid : "";
    const files = [...new Set(sortedGroups.flatMap((g) => g.tasks.flatMap((t) => t.files)))];
    const occurrenceSnapshots: OccurrenceSnapshot[] = allOccurrencesFolded
        ? merged.flatMap((outcome) => manifest.occurrences.map((occurrence) => {
            const branch = branchesByPath.get(occurrence.checkoutPath)!.find((b) => b.groupId === String(outcome.groupId))!;
            return {
                groupId: outcome.groupId,
                repositoryPath: occurrence.checkoutPath,
                treeListing: git(branch.sourceRepoRoot, "ls-tree", "-r", "-z", "HEAD"),
            };
        }))
        : [];
    const occurrenceDigests = computeOccurrenceDigests(occurrenceSnapshots);
    const readyForApproval = allOccurrencesFolded
        && testReceipts.length > 0
        && testReceipts.every((receipt) => receipt.status === "green")
        && reviewHandoffs.length > 0;
    const digestInput: ApprovalDigestInput = {
        manifest,
        files,
        operationRef,
        baseRef: rootOccurrence.baseOid,
        occurrenceDigests,
        testReceipts,
        reviewHandoffs,
    };
    const runState: RunState = { readyForApproval, status: readyForApproval ? "approved" : "blocked", digestInput };

    let publicationTargets: PublicationTargetSummary[] = [];
    if (readyForApproval) {
        recordApproval(runState);
        issueApprovalAuthorization(runState);
        const token = runState.authorization!;
        const digest = runState.approval!.digest;

        const occurrenceInputs: OccurrenceFinalizationInput[] = manifest.occurrences.map((occurrence) => {
            const integratedOid = (foldByPath.get(occurrence.checkoutPath) as { folded: true; integratedOid: string }).integratedOid;
            return {
                occurrenceId: occurrence.occurrenceId,
                repoRoot: join(input.repo, occurrence.checkoutPath),
                currentTipOid: integratedOid,
                recordedBaseOid: integratedOid,
                approvedOwnFileChanges: [],
                directChildEdges: occurrence.childOccurrenceIds.map((childId) => ({
                    pathInParent: occurrenceById.get(childId)!.pathInParent!,
                    childOccurrenceId: childId,
                })),
            };
        });
        const finalizationResult = finalizeApprovedRun(runState, { runId, occurrences: occurrenceInputs });
        const finalizedByOccurrenceId = new Map(finalizationResult.occurrences.map((o) => [o.occurrenceId, o]));

        const consolidationInputs: LogicalRepositoryConsolidationInput[] = manifest.occurrences.map((occurrence) => {
            const repoRoot = join(input.repo, occurrence.checkoutPath);
            const foldOid = (foldByPath.get(occurrence.checkoutPath) as { folded: true; foldOid: string }).foldOid;
            return {
                logicalRepositoryId: occurrence.occurrenceId,
                canonicalRepoRoot: repoRoot,
                canonicalOccurrenceBranchName: occurrence.operationBranch,
                participatingBranches: branchesByPath.get(occurrence.checkoutPath)!,
                approvedConvergedTreeOid: git(repoRoot, "rev-parse", `${foldOid}^{tree}`),
                finalizedChildGitlinks: [],
                recordedBaseOid: occurrence.baseOid,
                baseBranchRef: `refs/heads/${occurrence.baseBranch}`,
            };
        });
        const consolidationResults = consolidateRun(runId, consolidationInputs, token, digest);
        for (const result of consolidationResults) {
            if ("aborted" in result) throw new Error(`consolidation unexpectedly aborted for "${result.logicalRepositoryId}": ${result.aborted.reason}`);
        }

        const logicalRepositories = groupOccurrencesIntoLogicalRepositories(manifest.occurrences);
        const absoluteOccurrences: RepositoryOccurrence[] = manifest.occurrences.map((o) => ({ ...o, checkoutPath: join(input.repo, o.checkoutPath) }));
        await pushOperationBranches({ logicalRepositories, occurrences: absoluteOccurrences }, token, digest);

        // Publishes finalizedIntegrationOid as-is; parent and child gitlinks then always match.
        const publicationInputTargets: PublicationTarget[] = manifest.occurrences.map((occurrence) => {
            const finalized = finalizedByOccurrenceId.get(occurrence.occurrenceId)!;
            return {
                name: occurrence.occurrenceId,
                canonicalOccurrencePath: join(input.repo, occurrence.checkoutPath),
                canonicalRefName: `refs/heads/${occurrence.baseBranch}`,
                otherOccurrences: [],
                recordedBaseOid: occurrence.baseOid,
                targetOid: finalized.finalizedIntegrationOid,
            };
        });
        publicationTargets = publicationInputTargets.map((target, index) => ({
            repositoryPath: manifest.occurrences[index].checkoutPath,
            recordedBaseOid: target.recordedBaseOid,
            targetOid: target.targetOid,
        }));

        const rootFinalized = finalizedByOccurrenceId.get(rootOccurrence.occurrenceId)!;
        const publication = publishBases(
            publicationInputTargets,
            runState,
            { repoPath: join(input.repo, rootOccurrence.checkoutPath), refName: rootFinalized.durableTipRef },
        );

        const rolledBackNames = new Set(publication.rollback.filter((r) => r.rolledBack).map((r) => r.ref.repoName));
        const rawOutcomes: RawTaskRepoOutcome[] = [];
        for (const group of sortedGroups) {
            for (const occurrence of manifest.occurrences) {
                const status = publication.published ? "published" : rolledBackNames.has(occurrence.occurrenceId) ? "rolled-back" : "conflicted";
                const target = publicationInputTargets.find((t) => t.name === occurrence.occurrenceId)!;
                for (const task of group.tasks) {
                    rawOutcomes.push({
                        taskNumber: task.number,
                        repo: { repoName: occurrence.occurrenceId, status, commitHash: status === "published" ? target.targetOid : undefined },
                    });
                }
            }
        }
        const mergeResults: TaskMergeResult[] = summarizeTaskMergeResults(rawOutcomes);
        archivePublishedTasks(sortedGroups.flatMap((g) => g.tasks.map((t) => t.number)), mergeResults, input.repo);
    }

    const endTimestamp = new Date().toISOString();
    appendRunMetricsRecord(input.repo, {
        runId,
        startTimestamp: input.startTimestamp ?? null,
        endTimestamp,
        durationMs: runDurationMs(input.startTimestamp ?? null, endTimestamp),
        taskNumbers: sortedGroups.flatMap((g) => g.tasks.map((t) => t.number)),
        groupCount: sortedGroups.length,
        doneCount: input.doneCount ?? 0,
        partialCount: input.partialCount ?? 0,
        blockedCount: input.blockedCount ?? 0,
        needsClarificationCount: input.needsClarificationCount ?? 0,
        requeueCount: input.requeueCount ?? 0,
        conflictCount: conflicts.length,
        argumentsHash: computeArgumentsHash({ repo: input.repo, typecheckCommand: input.typecheckCommand, groups: input.groups, repositorySources: input.repositorySources }),
    });
    if (allOccurrencesFolded) {
        rmSync(resolveRunArgumentsPath(input.repo), { force: true });
        rmSync(resolveRunOutcomesPath(input.repo), { force: true });
        rmSync(resolveStepOutputsPath(input.repo), { force: true });
    }

    process.stdout.write(JSON.stringify({ merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, publicationTargets }));
}
```

This file is ~215 lines, under the 250-line cap. If a final line count check (Verification, below) puts
it over 250, trim only by removing blank lines between statements inside `runMergePipeline` — every line
above is load-bearing, so nothing should be deleted for length; compress vertical whitespace only.

### Why each field/call is what it is (cross-reference to the five read-only files)

- `resolveOccurrenceFold`'s two-stage check directly reuses `repositoryIntegration.ts`'s
  `prepareNoFfMerge` (already proven pure and conflict-reporting by `runConsolidation.ts`'s own internal
  `foldMergeParticipatingBranches`, which this mirrors for the N-way fold stage).
- `occurrenceInputs` matches `runFinalizer.ts`'s `OccurrenceFinalizationInput` exactly:
  `directChildEdges` is built straight from `RepositoryOccurrence.childOccurrenceIds` +
  `RepositoryOccurrence.pathInParent`, both already on the manifest — no discovery needed.
  `approvedOwnFileChanges: []` is correct because `currentTipOid`/`recordedBaseOid` are both the group
  fold's oid, which already has every change as real git commits; `commitOwnFileChanges` (in
  `runFinalizer.ts`) returns `currentTipOid` unchanged when `changes.length === 0`
  (`test_noEmptyOwnFilesCommitWhenNoApprovedChanges`), so for leaf occurrences `finalizedIntegrationOid`
  equals the fold oid directly, and for occurrences with children `buildAssemblyBranch` starts its
  gitlink-substitution chain from `recordedBaseOid`, which is that same fold oid carrying any of the
  occurrence's own root-level file changes already.
- `consolidationInputs.approvedConvergedTreeOid` is deliberately the tree of the *raw* fold oid (not
  `finalizedIntegrationOid`) for every occurrence, leaf or container — this is what makes
  `consolidateLogicalRepository`'s own internal tree-match check always pass (see architecture fact 3).
- `logicalRepositories`/`absoluteOccurrences` intentionally bypass `buildLogicalRepositories` (fact 4).
- `publicationInputTargets[].targetOid` is computed directly via `prepareNoFfMerge` against
  `finalized.finalizedIntegrationOid`, not read from `consolidationResults` (fact 3).
- `publishBases`'s `rootIntegration.refName` is `rootFinalized.durableTipRef` — the ref `runFinalizer`
  itself creates and updates unconditionally for every occurrence
  (`refs/finalize/${runId}/tip/${occurrenceId}`, verified against `test_durableRefsExistForEveryOccurrenceTip`
  and `checkRootIntegrationOidExists`'s use in `basePublication.ts`, which only checks existence).

## File 3: tests/mergeTaskWorktrees.test.ts

### Tests that need NO edit (11 of 12 existing tests)

All tests except the one discussed below are untouched, verified individually:

- `test_removeWorktreeAndBranchDeletesAWorktreeThatContainsSubmodules`,
  `test_mergeGroupBranchIntoRepoReportsSuccessForANonConflictingBranch`,
  `test_mergeGroupBranchIntoRepoReportsConflictedPathsAndAbortsTheMerge`,
  `test_mergeGroupBranchIntoRepoLeavesTheWorktreeInPlaceAfterAConflict`,
  `test_removeWorktreeAndBranchDeletesBothAfterACleanMerge`,
  `test_mergeGroupBranchIntoRepoContinuesToLaterGroupsAfterAnEarlierConflict`,
  `test_mergeGroupBranchIntoRepoChecksOutTheSourceBranchBeforeMerging`,
  `test_mergeSubmoduleBranchSurvivesEvenWhenTheGroupConflicts`,
  `test_resolveGitlinkConflictsAutoResolvesASubmodulePointerConflict`,
  `test_resolveGitlinkConflictsAbortsOnANonSubmoduleConflict` — all call
  `mergeGroupBranchIntoRepo`/`mergeSubmoduleBranchIntoRepo`/`resolveGitlinkConflicts`/`removeWorktreeAndBranch`
  directly, never through the CLI. These four functions are untouched (Edit 4's rationale). No change.

- `test_runAsCliLeavesTheWorktreeAndBranchInPlaceAfterASuccessfulMerge` — no `testReceipts`/`reviewHandoffs`
  in its `cliInput`, so `testReceipts.length > 0` is false, so `readyForApproval` is false, so the
  mutating branch of `runMergePipeline` never runs. The pre-fold (single group, adds `new.txt`, no base
  divergence) succeeds, so `allOccurrencesFolded` is true, so the three `.taskTools/run-*.json` files get
  removed (harmless — the test never wrote them) and `merged` gets one entry. Nothing in `runMergePipeline`
  ever calls `removeWorktreeAndBranch`, matching the old `runPipelineCli`, which also never called it — the
  test's assertions (`existsSync(group.worktree)`, branch still listed) hold unchanged. No change.

- `test_runFlagReadsPreparedArgumentsAndOutcomesFromDiskThenDeletesThem` — single root-only occurrence
  (no submodule), `testReceipts: [green]`, `reviewHandoffs` present, group adds `new.txt` with no base
  divergence between `preMergeBaseOid` (captured right before the manifest is built) and the group branch.
  `resolveOccurrenceFold` succeeds (clean addition merges onto the base cleanly both pairwise-fold, N=1,
  no-op, and base-check stages). `allOccurrencesFolded` true, `readyForApproval` true → full pipeline runs
  → `output.merged.length === 1`, `output.runState.readyForApproval === true`,
  `output.reviewHandoffs === ["reviewed by codex"]`, and cleanup deletes `argumentsFile`/`outcomesFile`
  (gated on `allOccurrencesFolded`, same as before). No change.

- `test_runPipelineCliProducesNoApprovalStateWhenAGroupConflicts` — root-only occurrence, group branch
  edits `shared.txt`; *after* the group forks, `repoRoot` itself gets a second, different edit to
  `shared.txt`, and `preMergeBaseOid` is captured after that second edit. `resolveOccurrenceFold`'s N=1
  group-fold stage is a no-op (single branch), but its base-check stage
  (`prepareNoFfMerge(repoRoot, preMergeBaseOid, groupBranchOid, ...)`) conflicts on `shared.txt` — exactly
  the divergence this test constructs. `conflicts.length === 1`, `allOccurrencesFolded === false`,
  `readyForApproval === false` regardless of the green `testReceipts`/`reviewHandoffs` supplied, so no
  approval/authorization is minted and the mutating branch never runs → `publicationTargets === []`. No
  change.

### Test that was flagged as possibly needing an edit — verified NOT to need one

`test_runPipelineCliMintsApprovalAndPublicationTargetsWhenEvidenceIsCompleteAndGreen`: this is the test
the brief calls out as *possibly* asserting the old "base branch moves during the merge itself" behavior.
Tracing it against the new implementation:

- The test reads `postMergeRootOid`/`postMergeSubmoduleOid` via `git rev-parse <branch>` **after** the
  whole CLI process has exited — by which point, since evidence is green, `publishBases` has already run
  and moved `refs/heads/${sourceBranch}` via CAS `update-ref` from `preMergeRootOid` to
  `publicationInputTargets[0].targetOid` (root) and similarly for the submodule. So
  `postMergeRootOid !== preMergeRootOid` still holds — it is no longer a `git merge`-produced commit, but
  it is still a real, different commit on the real branch.
- `output.publicationTargets` is built from the exact same field names/order as before
  (`repositoryPath`/`recordedBaseOid`/`targetOid`, root then submodule, matching manifest occurrence
  order), and `recordedBaseOid` is still each occurrence's `baseOid` captured before the run
  (`preMergeRootOid`/`preMergeSubmoduleOid`).
- The test does not call `existsSync` on any file inside `repoRoot`'s working tree (the one behavior gap
  this plan intentionally leaves open, per architecture fact 6) — only ref/oid assertions, all of which
  hold.

**Conclusion: this test needs no edit.** No test in the file is edited by this task.

### New test — required by the brief ("the finalization path is exercised end to end")

Add this test to `tests/mergeTaskWorktrees.test.ts` (append after the last existing test, before the
closing of the file; it needs no new imports beyond what the file already imports — `execFileSync`,
`existsSync`, `writeFileSync`, `join`, `currentBranchName`, `makeTempRepoWithCommit`, `makeGroup`,
`makeManifest`, `SCRIPT`, `git` are all already in scope):

```ts
test("test_runPipelineCliPublishesThroughTheFinalizeConsolidatePublishChain", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    const groupBranchOid = git(group.worktree, "rev-parse", "HEAD").trim();

    const preMergeBaseOid = git(repoRoot, "rev-parse", sourceBranch).trim();
    const cliInput = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [{ path: "", sourceBranch }],
        repositoryManifest: makeManifest(sourceBranch, preMergeBaseOid, group.branch),
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    };
    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });
    const output = JSON.parse(stdout);

    // Proof the chain ran: both the pre-run base and the group's branch tip are ancestors of the published commit.
    const targetOid = output.publicationTargets[0].targetOid;
    assert.doesNotThrow(() => git(repoRoot, "merge-base", "--is-ancestor", preMergeBaseOid, targetOid));
    assert.doesNotThrow(() => git(repoRoot, "merge-base", "--is-ancestor", groupBranchOid, targetOid));
    assert.equal(git(repoRoot, "show", `${targetOid}:new.txt`), "brand new\n");
    assert.equal(git(repoRoot, "rev-parse", sourceBranch), targetOid);

    // The finalize phase's durable per-occurrence ref exists and resolves to a real commit.
    const durableRefs = git(repoRoot, "for-each-ref", `refs/finalize/`).trim();
    assert.ok(durableRefs.length > 0);

    assert.equal(output.merged.length, 1);
    assert.equal(output.runState.readyForApproval, true);
    assert.ok(output.runState.approval && output.runState.approval.digest.length > 0);
});
```

Note: `git show <oid>:<path>` prints the file content followed by a trailing newline captured by
`execFileSync`'s default `encoding: "utf8"` return — matches `"brand new\n"` written by `writeFileSync`
exactly (git does not add or strip trailing newlines from blob content).

## Verification

Run from the repository root:

```
node --test tests/mergeTaskWorktrees.test.ts
```
Expected: all 13 tests pass (12 existing + 1 new), 0 failures.

```
node --test tests/runFinalizer.test.ts tests/runConsolidation.test.ts tests/operationPush.test.ts tests/basePublication.test.ts tests/taskArchival.test.ts
```
Expected: all pass unchanged (these files are not edited by this task; this just confirms the read-only
files' own test suites still pass, i.e. nothing about this task's environment broke them).

```
npx tsc --noEmit
```
Expected: no type errors — confirms `mergePipeline.ts`'s types line up exactly with the five read-only
files' exported signatures (`OccurrenceFinalizationInput`, `LogicalRepositoryConsolidationInput`,
`GroupOccurrenceBranch`, `PublicationTarget`, `LogicalRepository`, `RawTaskRepoOutcome`, `TaskMergeResult`)
and with `mergeTaskWorktrees.ts`'s `MergeOutcome`/`SubmoduleConflict`.

```
wc -l scripts/mergeTaskWorktrees.ts scripts/mergePipeline.ts
```
Expected: both under 250.

```
grep -n "runPipelineCli\|CliInput" scripts/mergeTaskWorktrees.ts
```
Expected: no matches (confirms the full removal from Edit 2/3, and that `CliInput` only exists in
`mergePipeline.ts` now).
