# Task 80 plan: detect destination-branch drift in the merge phase, reconcile instead of aborting

## Design summary (the "why", once, up front)

This plan was implemented in full in a scratch sandbox against real copies of the current source
tree, type-checked with the repo's own `tsconfig.json`, and exercised with `node --test` (including
the full `tests/` suite: 1128/1131 passing, the 3 failures being unrelated to this change — see
"Verification" at the end). Every code block below is the exact, working text; line counts were
measured with `wc -l`, not estimated.

- **Per-group, per-repository-path fork points, not a single run-wide scalar.** `PreparedGroup` gets
  a new **optional** field `forkPoints?: { repositoryPath: string; oid: string }[]` (`""` for the
  root, else the submodule's relative path, matching `coordinates.relativePath` in
  `mergePipeline.ts`). It is optional, not required, because `tests/tackleMetrics.test.ts` — **not**
  in this task's owned-file list — constructs a bare `PreparedGroup` literal with no `forkPoints`
  field; making it required broke that file's type-check in the sandbox run. Every read site already
  uses `?.`, so optionality costs nothing at runtime; it only exists to keep the unowned test
  type-checking. `createWorktreeForGroup`'s signature and behavior are **not** touched, which is what
  keeps `tests/prepareTasks.test.ts` and `tests/prepareTasksIntegration.test.ts` (both unowned, and
  confirmed via `rg -lw createWorktreeForGroup` to call it directly with the current one-`string`-arg
  signature) unaffected.
- **Capture happens once per group, in `buildWorkflowArguments`, right after `createWorktreeForGroup`
  returns** — by that point `createBranchInEveryRepository` has already run *inside*
  `createWorktreeForGroup`, so root and every submodule are already on the group's branch, and
  `git rev-parse HEAD` at each path is the true fork point. The submodule path list itself is
  computed **once, from `repoRoot`**, before any worktree exists — calling `submodulePaths()` again
  on the worktree *after* its branches have switched throws `"needs branch resolution"` (a real
  failure hit and fixed during sandbox testing: `submodulePaths` calls `bootstrapRepositoryManifest`,
  which expects an origin-tracking branch, and a freshly-checked-out `task-group-N` branch inside a
  submodule doesn't have one). Since submodule path *strings* depend only on `.gitmodules`/tree shape
  (identical across every worktree cut from the same commit), computing them once from `repoRoot` and
  reusing that list for every group's OID capture is correct and sidesteps the failure entirely.
- **`scripts/baseDrift.ts` (new, owned)** holds every drift primitive: `checkBaseDrift` (fork-point
  vs. destination-tip classification), `readDestinationTip`, `probeMergeTreeConflicts` (the
  `git merge-tree --write-tree` dry-run, moved here from `mergePipeline.ts` — a **real** extraction,
  not the rejected plan's cosmetic one-lining), and `computeDriftByGroup` (drift for every
  group/occurrence pair, using primitive parameter types so it needs no import from
  `mergePipeline.ts`'s or `prepareTasks.ts`'s local types).
- **Path A (`scripts/mergePipeline.ts`) reconciles *every* occurrence, not only the root.**
  `computeDriftByGroup` is called with the full occurrence list; any occurrence with a group whose
  drift status is `"advanced"` or `"diverged"` gets its `baseOid` mutated in place, **before**
  `baseMismatch` is computed and before the merge-tree probe loop runs. Because `occurrenceById`,
  `rootOccurrence`, and `canonicalOccurrence` all dereference the same `manifest.occurrences` objects
  by reference, this one mutation point is what every later read (`digestInput.baseRef`,
  `consolidationInput.recordedBaseOid`, the post-push `readCurrentRefOid !== occurrence.baseOid` CAS
  check, `summaryTargets`) picks up automatically — the mechanism the earlier design got right, now
  applied per-occurrence instead of root-only.
- **A submodule worktree checkout is a separate clone and does not share objects with the canonical
  submodule checkout** — a second real bug hit and fixed during sandbox testing.
  `git merge-tree --write-tree <reconciledDestTip> <groupTip>` failed with `"not something we can
  merge"` inside a submodule worktree until the reconciled tip was `git fetch`ed into that worktree's
  submodule clone first. The fix is one line: for every drifted occurrence, fetch its new `baseOid`
  into every group's corresponding repo before the probe loop runs. (Root worktrees don't need this —
  `git worktree add` shares the object database with `repoRoot` directly — but the fetch is harmless
  and near-instant there too, so it isn't special-cased away.)
- **`baseDrift` is reported per group (root-level, on `MergeOutcome`) and per submodule (on each
  `SubmoduleConflict`, alongside its existing `path` field)**, normalized so a `"none"` status is
  reported as `null` — consistent everywhere a `BaseDriftResult | null` is produced.
- **Path B (`scripts/mergeTaskWorktrees.ts`'s `mergeGroupBranchIntoRepo`) now actually rebases, and
  actually recognizes a resolved retry.** Whether a rebase is needed is decided by asking "is the live
  destination tip already reachable from the group branch's current HEAD?" (`checkBaseDrift(worktree,
  destTip, currentTip).status !== "diverged"`), **not** by comparing the stale recorded fork point
  every time — a first design that only checked the stale fork point would retry the *same* rebase
  forever even after a human/agent completed `git rebase --continue` by hand, since the fork point
  never changes. Ancestry-based "already caught up" is what makes a retry after a hand-resolved
  rebase succeed (verified with a dedicated test that runs the function twice, resolving the conflict
  between calls). Path B prefers `group.forkPoints`, falling back to `git merge-base <group.branch>
  <sourceBranch>` only for legacy/orphaned worktrees with no persisted fork point; if that fallback
  itself fails (no shared history at all), the function returns a structured `MergeOutcome` naming
  the failure instead of throwing or guessing.
- **Conflict resolution for drift routes through the existing unblock subagent**
  (`skills/tackle-tasks/merge.workflow.js`) exactly as the brief requires — `baseDrift` on
  `MergeOutcome`/`SubmoduleConflict` is exactly what the agent already receives via
  `report.conflicts`. Only the prompt text changes: a new step tells the agent to rebase (root
  worktree, or the correct submodule path inside it) onto `baseDrift.destTip` starting from
  `baseDrift.forkPoint`, resolving with a `stage` + `rebase --continue` loop instead of the
  merge-and-commit loop used for ordinary conflicts; the forbidden-actions paragraph is reworded to
  permit rewriting the *task* branch (root or submodule worktree) while keeping the *destination*
  branch off-limits.
- **`scripts/mergePipeline.ts` line budget.** The real extraction of `probeMergeTreeConflicts` (and
  the parsing helper it replaced) into `baseDrift.ts` is what pays for the new drift-orchestration
  code added back in. Measured with `wc -l` after every edit in the sandbox: **249 lines — identical
  to the file's current line count**, comfortably under the 250 cap.
- **`scripts/prepareTasks.ts`: 248 lines** (was 231) — under the cap, no split needed.
  **`scripts/mergeTaskWorktrees.ts`: 243 lines** (was 215) — under the cap, no split needed.
  **`scripts/baseDrift.ts` (new): 62 lines.**
- **`runMergePhase.ts`'s `MergeFailure.conflicts` is already typed `unknown[]`**; the new `baseDrift`
  field passes through untouched. No edit needed there.
- **Existing test compatibility, checked one by one, not assumed:** every pre-existing
  `mergeGroupBranchIntoRepo` conflict test (`test_mergeGroupBranchIntoRepoReportsConflictedPathsAndAbortsTheMerge`
  and its siblings) still passes unchanged — the failure now originates from a pre-merge rebase
  conflict inside the worktree rather than a merge-and-abort inside `repoRoot`, but the observable
  assertions (`merged: false`, `conflictedFilePaths: ["shared.txt"]`, no `MERGE_HEAD` in `repoRoot`)
  hold either way, confirmed by running the suite, not by inspection alone. One existing test,
  `test_publicationFailureLeavesTaskOpenAndKeepsRunFilesWhileSuccessArchives`, encoded the *old*
  behavior this task deliberately replaces (its "raced" half wrote to an *unrelated* file and expected
  publication to refuse merely because the base moved) — updated below to write a *conflicting* edit
  to the same file the group touches, which still correctly refuses, now for the right reason
  (verified: a genuine conflict still blocks; mere drift no longer does).

## Files touched, in implementation order

### 1. `scripts/baseDrift.ts` (new file)

Full contents (62 lines, verified with `wc -l`):

```ts
// Drift primitives: fork-point comparison, merge-tree probing, and per-occurrence reconciliation.
import { execFileSync } from "node:child_process";

export type BaseDriftStatus = "none" | "advanced" | "diverged";

export type BaseDriftResult = { status: BaseDriftStatus; forkPoint: string; destTip: string };

export function readDestinationTip(repoRoot: string, destBranch: string): string {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", `refs/heads/${destBranch}`], { encoding: "utf8" }).trim();
}

export function checkBaseDrift(repoRoot: string, forkPoint: string, destTip: string): BaseDriftResult {
    if (forkPoint === destTip) return { status: "none", forkPoint, destTip };
    try {
        execFileSync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", forkPoint, destTip], { stdio: "ignore" });
        return { status: "advanced", forkPoint, destTip };
    } catch (error) {
        if ((error as { status?: number }).status === 1) return { status: "diverged", forkPoint, destTip };
        throw error;
    }
}

// Returns the conflicted file paths from a dry-run `git merge-tree`, or null when the merge is clean.
export function probeMergeTreeConflicts(repoRoot: string, baseOid: string, tipOid: string): string[] | null {
    try {
        execFileSync("git", ["-C", repoRoot, "merge-tree", "--write-tree", baseOid, tipOid], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return null;
    } catch (error) {
        const stdout = (error as { stdout?: string }).stdout ?? "";
        const [, ...lines] = (stdout.split("\n\n")[0] ?? "").split("\n");
        return [...new Set(lines.filter(Boolean).map((line) => line.split("\t")[1]))];
    }
}

export type OccurrenceCoordinate = { occurrenceId: string; repoRoot: string; relativePath: string; baseBranch: string };
export type GroupForkPoints = { groupId: number; forkPoints?: { repositoryPath: string; oid: string }[] };

// Computes each group's drift against every occurrence's live destination tip.
export function computeDriftByGroup(
    occurrences: OccurrenceCoordinate[],
    groups: GroupForkPoints[],
): { destTipByOccurrence: Map<string, string>; driftByGroup: Map<number, Map<string, BaseDriftResult>>; driftedOccurrenceIds: Set<string> } {
    const destTipByOccurrence = new Map(occurrences.map((o) => [o.occurrenceId, readDestinationTip(o.repoRoot, o.baseBranch)]));
    const driftByGroup = new Map<number, Map<string, BaseDriftResult>>();
    for (const group of groups) {
        const perOccurrence = new Map<string, BaseDriftResult>();
        for (const occurrence of occurrences) {
            const forkPoint = group.forkPoints?.find((fp) => fp.repositoryPath === occurrence.relativePath)?.oid;
            if (forkPoint) perOccurrence.set(occurrence.occurrenceId, checkBaseDrift(occurrence.repoRoot, forkPoint, destTipByOccurrence.get(occurrence.occurrenceId)!));
        }
        driftByGroup.set(group.groupId, perOccurrence);
    }
    const driftedOccurrenceIds = new Set(
        occurrences
            .filter((o) => groups.some((g) => {
                const status = driftByGroup.get(g.groupId)!.get(o.occurrenceId)?.status;
                return status === "advanced" || status === "diverged";
            }))
            .map((o) => o.occurrenceId),
    );
    return { destTipByOccurrence, driftByGroup, driftedOccurrenceIds };
}
```

Why `"advanced"` vs `"diverged"` both exist: `--is-ancestor` succeeding means the destination
fast-forwarded past the fork point (the common case); failing (exit code exactly `1`) means the
destination's current tip is not a descendant of the fork point (e.g. reset/rebased). Any *other*
exit code (invalid OID, corrupt repo, etc.) is rethrown rather than silently reported as `"diverged"`
— confirmed with a dedicated test.

### 2. `tests/baseDrift.test.ts` (new file)

Full contents (93 lines, run and passing: 7/7):

```ts
// Behavioral checks for baseDrift.ts: drift classification and merge-tree conflict probing. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBaseDrift, probeMergeTreeConflicts, readDestinationTip } from "../scripts/baseDrift.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "base-drift-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

test("test_checkBaseDriftReportsNoneWhenForkPointStillTheTip", () => {
    const repoRoot = makeTempRepoWithCommit();
    const tip = git(repoRoot, "rev-parse", "HEAD").trim();
    const result = checkBaseDrift(repoRoot, tip, tip);
    assert.equal(result.status, "none");
});

test("test_checkBaseDriftReportsAdvancedWhenDestinationFastForwarded", () => {
    const repoRoot = makeTempRepoWithCommit();
    const forkPoint = git(repoRoot, "rev-parse", "HEAD").trim();
    writeFileSync(join(repoRoot, "new.txt"), "new\n");
    git(repoRoot, "add", "new.txt");
    git(repoRoot, "commit", "-q", "-m", "advance destination");
    const destTip = git(repoRoot, "rev-parse", "HEAD").trim();
    const result = checkBaseDrift(repoRoot, forkPoint, destTip);
    assert.equal(result.status, "advanced");
    assert.equal(result.forkPoint, forkPoint);
    assert.equal(result.destTip, destTip);
});

test("test_checkBaseDriftReportsDivergedWhenHistoriesDoNotShareAnAncestor", () => {
    const repoRoot = makeTempRepoWithCommit();
    const forkPoint = git(repoRoot, "rev-parse", "HEAD").trim();
    git(repoRoot, "checkout", "-q", "--orphan", "unrelated");
    writeFileSync(join(repoRoot, "other.txt"), "other\n");
    git(repoRoot, "add", "other.txt");
    git(repoRoot, "commit", "-q", "-m", "unrelated history");
    const destTip = git(repoRoot, "rev-parse", "HEAD").trim();
    const result = checkBaseDrift(repoRoot, forkPoint, destTip);
    assert.equal(result.status, "diverged");
});

test("test_checkBaseDriftRethrowsOnAnUnrecognizedGitFailureInsteadOfGuessingDiverged", () => {
    const repoRoot = makeTempRepoWithCommit();
    const tip = git(repoRoot, "rev-parse", "HEAD").trim();
    assert.throws(() => checkBaseDrift(repoRoot, "0000000000000000000000000000000000000000", tip));
});

test("test_readDestinationTipReadsTheBranchsCurrentCommit", () => {
    const repoRoot = makeTempRepoWithCommit();
    const branch = git(repoRoot, "branch", "--show-current").trim();
    const expected = git(repoRoot, "rev-parse", "HEAD").trim();
    assert.equal(readDestinationTip(repoRoot, branch), expected);
});

test("test_probeMergeTreeConflictsReturnsNullWhenTheMergeIsClean", () => {
    const repoRoot = makeTempRepoWithCommit();
    const baseOid = git(repoRoot, "rev-parse", "HEAD").trim();
    writeFileSync(join(repoRoot, "new.txt"), "new\n");
    git(repoRoot, "add", "new.txt");
    git(repoRoot, "commit", "-q", "-m", "clean addition");
    const tipOid = git(repoRoot, "rev-parse", "HEAD").trim();
    assert.equal(probeMergeTreeConflicts(repoRoot, baseOid, tipOid), null);
});

test("test_probeMergeTreeConflictsReturnsTheConflictedPathsWhenBothSidesEditTheSameLine", () => {
    const repoRoot = makeTempRepoWithCommit();
    const ancestor = git(repoRoot, "rev-parse", "HEAD").trim();
    writeFileSync(join(repoRoot, "seed.txt"), "branch-a\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "branch a edits seed.txt");
    const branchA = git(repoRoot, "rev-parse", "HEAD").trim();
    git(repoRoot, "checkout", "-q", "-b", "branch-b", ancestor);
    writeFileSync(join(repoRoot, "seed.txt"), "branch-b\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "branch b edits seed.txt");
    const branchB = git(repoRoot, "rev-parse", "HEAD").trim();
    assert.deepEqual(probeMergeTreeConflicts(repoRoot, branchA, branchB), ["seed.txt"]);
});
```

### 3. `scripts/prepareTasks.ts` — 2 edits

**Edit 3a — add `ForkPoint` type and an optional `forkPoints` field to `PreparedGroup`.** Current
text:

```
export type PreparedGroup = {
    groupId: number;
    worktree: string;
    branch: string;
    scope: TaskGroupScope;
    tasks: PreparedTask[];
};
```

becomes:

```
export type ForkPoint = { repositoryPath: string; oid: string };

export type PreparedGroup = {
    groupId: number;
    worktree: string;
    branch: string;
    scope: TaskGroupScope;
    // Optional: unowned literals built before this field existed must still type-check.
    forkPoints?: ForkPoint[];
    tasks: PreparedTask[];
};
```

**Edit 3b — capture fork points in `buildWorkflowArguments`.** Current text:

```
export function buildWorkflowArguments(
    repoRoot: string,
    typecheckCommand: string,
    groups: TaskGroup[],
): WorkflowArguments {
    const repositorySources = collectRepositorySources(repoRoot);
    const preparedGroups: PreparedGroup[] = groups.map((group) => ({
        groupId: group.groupId,
        worktree: createWorktreeForGroup(repoRoot, group),
        branch: branchNameForGroup(group.groupId),
        scope: group.scope,
        tasks: group.taskNumbers.map((number) => ({
            number,
            briefFile: join(repoRoot, "plans", `brief-${number}.md`),
            planFile: join(repoRoot, "plans", `task-${number}-plan.md`),
            files: group.filePaths,
        })),
    }));
    return { repo: repoRoot, typecheckCommand, groups: preparedGroups, repositorySources };
}
```

becomes:

```
// Paths come from the caller: re-deriving them inside the worktree fails post-branch-switch.
function captureGroupForkPoints(worktree: string, paths: string[]): ForkPoint[] {
    return paths.map((repositoryPath) => ({
        repositoryPath,
        oid: execFileSync("git", ["-C", repositoryPath === "" ? worktree : join(worktree, repositoryPath), "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    }));
}

export function buildWorkflowArguments(
    repoRoot: string,
    typecheckCommand: string,
    groups: TaskGroup[],
): WorkflowArguments {
    const repositorySources = collectRepositorySources(repoRoot);
    const forkPointPaths = ["", ...submodulePaths(repoRoot)];
    const preparedGroups: PreparedGroup[] = groups.map((group) => {
        const worktree = createWorktreeForGroup(repoRoot, group);
        return {
            groupId: group.groupId,
            worktree,
            branch: branchNameForGroup(group.groupId),
            scope: group.scope,
            forkPoints: captureGroupForkPoints(worktree, forkPointPaths),
            tasks: group.taskNumbers.map((number) => ({
                number,
                briefFile: join(repoRoot, "plans", `brief-${number}.md`),
                planFile: join(repoRoot, "plans", `task-${number}-plan.md`),
                files: group.filePaths,
            })),
        };
    });
    return { repo: repoRoot, typecheckCommand, groups: preparedGroups, repositorySources };
}
```

No new imports needed: `execFileSync`, `join`, and `submodulePaths` are already imported at the top
of this file. `createWorktreeForGroup` and `runAsCli` are **not** edited.

Line count after both edits, measured: **248** (was 231). No split needed.

### 4. `scripts/mergePipeline.ts` — full-file replacement

This file changed too extensively (new import, two type extensions, a removed helper function
replaced by an imported one, a new reconciliation pre-pass, and a rewritten probe loop) for
line-anchored diffs to stay reliable. Replace the entire file with the following. It is the exact,
verified text — type-checked clean against every file that imports from it, and exercised by the
full `mergeTaskWorktrees.test.ts` suite (26/26 passing) plus the targeted new tests in file 7 below.

```ts
// Translates the CLI's flat merge input into the finalize/consolidate/push/publish/archive pipeline.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath, type WorkflowArguments } from "./prepareTasks.ts";
import { computeDriftByGroup, probeMergeTreeConflicts, type BaseDriftResult } from "./baseDrift.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import { computeOccurrenceDigests, recordApproval, issueApprovalAuthorization, finalizeApprovedRun, computeApprovalDigest, type OccurrenceSnapshot, type RunState, type ApprovalDigestInput } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import { validateRepositoryManifest, type RepositoryManifest, type RepositoryOccurrence } from "./repositoryManifest.ts";
import { normalizeRepositoryIdentity, type RepositoryIdentity } from "./submoduleUrlIdentity.ts";
import type { LogicalRepository } from "./logicalRepository.ts";
import { prepareNoFfMerge } from "./repositoryIntegration.ts";
import { consolidateRun, type GroupOccurrenceBranch, type LogicalRepositoryConsolidationInput } from "./runConsolidation.ts";
import { pushOperationBranches, type OperationPushInput } from "./operationPush.ts";
import { publishBases, readCurrentRefOid, type PublicationTarget } from "./basePublication.ts";
import { summarizeTaskMergeResults, archivePublishedTasks, type RawTaskRepoOutcome } from "./taskArchival.ts";
import { runFinalization } from "./runAuthorization.ts";
export type CliInput = WorkflowArguments & {
    runId?: string; startTimestamp?: string; doneCount?: number; partialCount?: number; blockedCount?: number;
    needsClarificationCount?: number; requeueCount?: number; testReceipts?: TestReceipt[]; reviewHandoffs?: string[];
    repositoryManifest: RepositoryManifest;
};
export type SubmoduleConflict = { path: string; conflictedFilePaths: string[]; failureReason: string | null; baseDrift: BaseDriftResult | null };
export type MergeOutcome = { groupId: number; merged: boolean; conflictedFilePaths: string[]; submoduleConflicts: SubmoduleConflict[]; worktree: string; failureReason: string | null; baseDrift: BaseDriftResult | null };
export type PublicationTargetSummary = { repositoryPath: string; recordedBaseOid: string; targetOid: string };
type Coordinate = { repoRoot: string; relativePath: string };
type LogicalGroup = { logicalId: string; occurrenceIds: string[]; canonicalOccurrenceId: string };
type ConsolidationOutcome = { preparedIntegrationOid: string; canonicalRepoRoot: string; canonicalRefName: string; recordedBaseOid: string; integrationRef: string };
function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^A-Za-z0-9_-]/g, "-") || "seg";
    return `${cleaned}-${createHash("sha256").update(segment).digest("hex").slice(0, 8)}`;
}
function digestIds(ids: string[]): string { return createHash("sha256").update([...ids].sort().join("\n")).digest("hex"); }
function occurrenceToLogicalId(groups: LogicalGroup[], occurrenceId: string): string { return groups.find((g) => g.occurrenceIds.includes(occurrenceId))!.logicalId; }
function buildCoordinates(repo: string, manifest: RepositoryManifest): Map<string, Coordinate> {
    const repoResolved = resolve(repo);
    const coordinates = new Map<string, Coordinate>();
    for (const occurrence of manifest.occurrences) {
        const repoRoot = occurrence.checkoutPath.startsWith("/") ? occurrence.checkoutPath : join(repo, occurrence.checkoutPath);
        const relativePath = repoRoot === repoResolved ? "" : relative(repoResolved, repoRoot);
        if (relativePath.startsWith("..")) throw new Error(`occurrence "${occurrence.occurrenceId}" checkout path "${repoRoot}" is outside repo "${repo}"`);
        coordinates.set(occurrence.occurrenceId, { repoRoot, relativePath: relativePath === "." ? "" : relativePath });
    }
    return coordinates;
}
function identityKey(occurrence: RepositoryOccurrence): string {
    if (occurrence.originUrl === "") return `blank:${occurrence.occurrenceId}`;
    const parsed = normalizeRepositoryIdentity(occurrence.originUrl);
    return parsed ? `parsed:${parsed.host}/${parsed.owner}/${parsed.repository}` : `opaque:${occurrence.originUrl}`;
}
function buildLogicalGroups(manifest: RepositoryManifest): LogicalGroup[] {
    const byKey = new Map<string, string[]>();
    for (const occurrence of manifest.occurrences) {
        const key = identityKey(occurrence);
        const existing = byKey.get(key);
        if (existing) existing.push(occurrence.occurrenceId); else byKey.set(key, [occurrence.occurrenceId]);
    }
    return [...byKey.entries()].map(([key, occurrenceIds]) => ({ logicalId: sanitizeSegment(key), occurrenceIds, canonicalOccurrenceId: occurrenceIds[0] }));
}
// Post-order DFS over occurrence childOccurrenceIds mapped through their owning logical group: children before parents.
function topoOrderLogicalGroups(groups: LogicalGroup[], manifest: RepositoryManifest): LogicalGroup[] {
    const occurrenceToLogical = new Map<string, string>();
    for (const group of groups) for (const id of group.occurrenceIds) occurrenceToLogical.set(id, group.logicalId);
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    const byId = new Map(groups.map((g) => [g.logicalId, g]));
    const mark = new Map<string, "gray" | "black">();
    const order: LogicalGroup[] = [];
    function visit(logicalId: string, path: string[]): void {
        if (mark.get(logicalId) === "black") return;
        if (mark.get(logicalId) === "gray") throw new Error(`logical repository dependency cycle: ${[...path, logicalId].join(" -> ")}`);
        mark.set(logicalId, "gray");
        const group = byId.get(logicalId)!;
        for (const occurrenceId of group.occurrenceIds) for (const childId of occurrenceById.get(occurrenceId)!.childOccurrenceIds) {
            const childLogicalId = occurrenceToLogical.get(childId)!;
            if (childLogicalId !== logicalId) visit(childLogicalId, [...path, logicalId]);
        }
        mark.set(logicalId, "black");
        order.push(group);
    }
    for (const group of groups) visit(group.logicalId, []);
    return order;
}
export async function runMergePipeline(input: CliInput): Promise<void> {
    const manifest = input.repositoryManifest;
    if (!manifest) throw new Error("no repository manifest given in CLI input; approval cannot be minted without pre-merge base OIDs");
    const validation = validateRepositoryManifest(manifest);
    if (!validation.valid) throw new Error(`invalid repository manifest: ${validation.errors.join("; ")}`);
    const roots = manifest.occurrences.filter((o) => o.parentOccurrenceId === null);
    if (roots.length !== 1) throw new Error(`repository manifest must have exactly one root occurrence, found ${roots.length}`);
    if (input.groups.length === 0) throw new Error("no groups given in CLI input");
    const rootOccurrence = roots[0];
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    const runId = input.runId ?? `merge-${Date.now()}-${process.pid}`;
    execFileSync("git", ["check-ref-format", `refs/heads/${runId}/probe`]);
    const sortedGroups = [...input.groups].sort((a, b) => a.groupId - b.groupId);
    const testReceipts = input.testReceipts ?? [];
    const reviewHandoffs = input.reviewHandoffs ?? [];
    const coordinates = buildCoordinates(input.repo, manifest);
    const logicalGroups = topoOrderLogicalGroups(buildLogicalGroups(manifest), manifest);
    const groupRepoRootFor = (groupWorktree: string, occurrenceId: string): string =>
        coordinates.get(occurrenceId)!.relativePath === "" ? groupWorktree : join(groupWorktree, coordinates.get(occurrenceId)!.relativePath);
    const rawTips = new Map<string, Map<number, string>>();
    for (const occurrence of manifest.occurrences) rawTips.set(occurrence.occurrenceId, new Map(sortedGroups.map((group) => [group.groupId, git(groupRepoRootFor(group.worktree, occurrence.occurrenceId), "rev-parse", "HEAD").trim()])));
    const { destTipByOccurrence, driftByGroup, driftedOccurrenceIds } = computeDriftByGroup(manifest.occurrences.map((o) => ({ occurrenceId: o.occurrenceId, repoRoot: coordinates.get(o.occurrenceId)!.repoRoot, relativePath: coordinates.get(o.occurrenceId)!.relativePath, baseBranch: o.baseBranch })), sortedGroups);
    for (const occurrence of manifest.occurrences.filter((o) => driftedOccurrenceIds.has(o.occurrenceId))) { occurrence.baseOid = destTipByOccurrence.get(occurrence.occurrenceId)!; for (const group of sortedGroups) git(groupRepoRootFor(group.worktree, occurrence.occurrenceId), "fetch", coordinates.get(occurrence.occurrenceId)!.repoRoot, occurrence.baseOid); }
    const baseMismatch = logicalGroups.find((group) => new Set(group.occurrenceIds.map((id) => occurrenceById.get(id)!.baseOid)).size > 1);
    const dropNoDrift = (drift: BaseDriftResult | undefined): BaseDriftResult | null => (drift && drift.status !== "none" ? drift : null);
    const merged: MergeOutcome[] = [];
    const conflicts: MergeOutcome[] = [];
    for (const group of sortedGroups) {
        const submoduleConflicts: SubmoduleConflict[] = [];
        let rootConflictedPaths: string[] = [];
        let failed = baseMismatch !== undefined;
        for (const occurrence of manifest.occurrences) {
            const coordinate = coordinates.get(occurrence.occurrenceId)!;
            const groupRepoRoot = groupRepoRootFor(group.worktree, occurrence.occurrenceId);
            const tipOid = rawTips.get(occurrence.occurrenceId)!.get(group.groupId)!;
            const conflictedPaths = probeMergeTreeConflicts(groupRepoRoot, occurrence.baseOid, tipOid);
            if (conflictedPaths) {
                failed = true;
                const baseDrift = dropNoDrift(driftByGroup.get(group.groupId)!.get(occurrence.occurrenceId));
                if (coordinate.relativePath === "") rootConflictedPaths = conflictedPaths;
                else submoduleConflicts.push({ path: coordinate.relativePath, conflictedFilePaths: conflictedPaths, failureReason: null, baseDrift });
            }
        }
        const rootDrift = dropNoDrift(driftByGroup.get(group.groupId)!.get(rootOccurrence.occurrenceId));
        const outcome: MergeOutcome = { groupId: group.groupId, merged: !failed, conflictedFilePaths: failed ? rootConflictedPaths : [], submoduleConflicts, worktree: group.worktree, failureReason: null, baseDrift: rootDrift };
        (failed ? conflicts : merged).push(outcome);
    }
    const allGroupsMerged = conflicts.length === 0;
    const occurrenceSnapshots: OccurrenceSnapshot[] = merged.flatMap((outcome) => manifest.occurrences.map((occurrence) => ({
        groupId: outcome.groupId, repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath,
        treeListing: git(groupRepoRootFor(outcome.worktree, occurrence.occurrenceId), "ls-tree", "-r", "-z", "HEAD"),
    })));
    const occurrenceDigests = computeOccurrenceDigests(occurrenceSnapshots);
    const files = [...new Set(sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.files)))];
    const operationRef = digestIds(sortedGroups.flatMap((group) => manifest.occurrences.map((o) => `${group.groupId}:${o.occurrenceId}:${rawTips.get(o.occurrenceId)!.get(group.groupId)}`)));
    const readyForApproval = allGroupsMerged && testReceipts.length > 0 && testReceipts.every((receipt) => receipt.status === "green") && reviewHandoffs.length > 0;
    const digestInput: ApprovalDigestInput = { manifest, files, operationRef, baseRef: rootOccurrence.baseOid, occurrenceDigests, testReceipts, reviewHandoffs };
    const runState: RunState = { readyForApproval, status: readyForApproval ? "approved" : "blocked", digestInput };
    const endMetrics = (conflictCount: number): void => {
        const endTimestamp = new Date().toISOString();
        const workflowArguments: WorkflowArguments = { repo: input.repo, typecheckCommand: input.typecheckCommand, groups: input.groups, repositorySources: input.repositorySources };
        appendRunMetricsRecord(input.repo, {
            runId: input.runId ?? endTimestamp, startTimestamp: input.startTimestamp ?? null, endTimestamp,
            durationMs: runDurationMs(input.startTimestamp ?? null, endTimestamp),
            taskNumbers: sortedGroups.flatMap((g) => g.tasks.map((t) => t.number)), groupCount: sortedGroups.length,
            doneCount: input.doneCount ?? 0, partialCount: input.partialCount ?? 0, blockedCount: input.blockedCount ?? 0,
            needsClarificationCount: input.needsClarificationCount ?? 0, requeueCount: input.requeueCount ?? 0,
            conflictCount, argumentsHash: computeArgumentsHash(workflowArguments),
        });
    };
    const printResult = (publicationTargets: PublicationTargetSummary[]): void => { process.stdout.write(JSON.stringify({ merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, publicationTargets })); };
    if (!readyForApproval) { endMetrics(conflicts.length); printResult([]); return; }
    recordApproval(runState);
    const token = issueApprovalAuthorization(runState);
    const digest = computeApprovalDigest(runState.digestInput);
    const aborted = await runFinalization(token, digest, async (): Promise<boolean> => {
        const consolidations = new Map<string, ConsolidationOutcome>();
        for (const logicalGroup of logicalGroups) {
            const canonicalRepoRoot = coordinates.get(logicalGroup.canonicalOccurrenceId)!.repoRoot;
            const canonicalOccurrence = occurrenceById.get(logicalGroup.canonicalOccurrenceId)!;
            const participatingBranches: GroupOccurrenceBranch[] = [];
            for (const occurrenceId of logicalGroup.occurrenceIds) {
                const occurrence = occurrenceById.get(occurrenceId)!;
                const occurrenceSegment = sanitizeSegment(occurrenceId);
                for (const group of sortedGroups) {
                    const repoRoot = groupRepoRootFor(group.worktree, occurrenceId);
                    const proxyId = (childId: string): string => `proxy-${sanitizeSegment(childId)}`;
                    const directChildEdges = occurrence.childOccurrenceIds.map((childId) => ({ pathInParent: occurrenceById.get(childId)!.pathInParent!, childOccurrenceId: proxyId(childId) }));
                    const proxyInputs = occurrence.childOccurrenceIds.map((childId) => {
                        const child = consolidations.get(occurrenceToLogicalId(logicalGroups, childId))!;
                        return { occurrenceId: proxyId(childId), repoRoot: child.canonicalRepoRoot, currentTipOid: child.preparedIntegrationOid, recordedBaseOid: child.preparedIntegrationOid, approvedOwnFileChanges: [], directChildEdges: [] };
                    });
                    const finalizationRunId = `${runId}-finalize-${sanitizeSegment(logicalGroup.logicalId)}-${group.groupId}`;
                    const result = finalizeApprovedRun(runState, {
                        runId: finalizationRunId,
                        occurrences: [{ occurrenceId: occurrenceSegment, repoRoot, currentTipOid: rawTips.get(occurrenceId)!.get(group.groupId)!, recordedBaseOid: rawTips.get(occurrenceId)!.get(group.groupId)!, approvedOwnFileChanges: [], directChildEdges }, ...proxyInputs],
                    });
                    const finalizedOid = result.occurrences.find((o) => o.occurrenceId === occurrenceSegment)!.finalizedIntegrationOid;
                    const groupSegment = String(group.groupId).padStart(6, "0");
                    if (repoRoot !== canonicalRepoRoot) git(canonicalRepoRoot, "fetch", repoRoot, finalizedOid);
                    git(canonicalRepoRoot, "update-ref", `refs/heads/${groupSegment}/${occurrenceSegment}`, finalizedOid);
                    participatingBranches.push({ groupId: groupSegment, occurrencePath: occurrenceSegment, occurrenceId, branchOid: finalizedOid, sourceRepoRoot: canonicalRepoRoot });
                }
            }
            const sorted = [...participatingBranches].sort((a, b) => a.groupId.localeCompare(b.groupId) || a.occurrencePath.localeCompare(b.occurrencePath));
            let previewOid = sorted[0].branchOid;
            for (let i = 1; i < sorted.length; i++) {
                const foldResult = prepareNoFfMerge(canonicalRepoRoot, previewOid, sorted[i].branchOid, `preview fold ${runId}`);
                if (!foldResult.merged) return true; else previewOid = foldResult.commitOid;
            }
            const approvedConvergedTreeOid = git(canonicalRepoRoot, "rev-parse", `${previewOid}^{tree}`).trim();
            const consolidationInput: LogicalRepositoryConsolidationInput = {
                logicalRepositoryId: logicalGroup.logicalId, canonicalRepoRoot, canonicalOccurrenceBranchName: sanitizeSegment(logicalGroup.logicalId),
                participatingBranches, approvedConvergedTreeOid, finalizedChildGitlinks: [],
                recordedBaseOid: canonicalOccurrence.baseOid, baseBranchRef: `refs/heads/${canonicalOccurrence.baseBranch}`,
            };
            const [result] = consolidateRun(runId, [consolidationInput], token, digest);
            if ("aborted" in result) return true;
            const integrationRef = `refs/finalize/${runId}/integration/${sanitizeSegment(logicalGroup.logicalId)}`;
            git(canonicalRepoRoot, "update-ref", integrationRef, result.preparedIntegrationOid);
            consolidations.set(logicalGroup.logicalId, { preparedIntegrationOid: result.preparedIntegrationOid, canonicalRepoRoot, canonicalRefName: `refs/heads/${canonicalOccurrence.baseBranch}`, recordedBaseOid: canonicalOccurrence.baseOid, integrationRef });
        }
        const operationPushOccurrences = manifest.occurrences.map((occurrence) => {
            const logicalGroup = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            return { ...occurrence, operationBranch: `operations/${runId}/${sanitizeSegment(logicalGroup.logicalId)}` };
        });
        const operationPushLogicalRepositories: LogicalRepository[] = logicalGroups.map((group) => ({
            normalizedIdentity: normalizeRepositoryIdentity(occurrenceById.get(group.canonicalOccurrenceId)!.originUrl) ?? ({ host: "opaque", owner: "opaque", repository: group.logicalId } as RepositoryIdentity),
            occurrenceIds: group.occurrenceIds, selectedBaseOccurrenceId: group.canonicalOccurrenceId, canonicalOccurrenceId: group.canonicalOccurrenceId,
            lastWriterOccurrenceId: group.occurrenceIds[group.occurrenceIds.length - 1], convergenceDigest: digestIds(group.occurrenceIds),
            consolidationState: group.occurrenceIds.length === 1 ? "single" : "grouped",
        }));
        await pushOperationBranches({ logicalRepositories: operationPushLogicalRepositories, occurrences: operationPushOccurrences }, token, digest);
        for (const occurrence of manifest.occurrences) if (readCurrentRefOid(coordinates.get(occurrence.occurrenceId)!.repoRoot, `refs/heads/${occurrence.baseBranch}`) !== occurrence.baseOid) return true;
        const publicationTargets: PublicationTarget[] = logicalGroups.map((group) => {
            const consolidation = consolidations.get(group.logicalId)!;
            return {
                name: group.logicalId, canonicalOccurrencePath: consolidation.canonicalRepoRoot, canonicalRefName: consolidation.canonicalRefName,
                otherOccurrences: group.occurrenceIds.filter((id) => id !== group.canonicalOccurrenceId).map((id) => ({ path: coordinates.get(id)!.repoRoot, refName: `refs/heads/${occurrenceById.get(id)!.baseBranch}` })),
                recordedBaseOid: consolidation.recordedBaseOid, targetOid: consolidation.preparedIntegrationOid,
            };
        });
        const rootConsolidation = consolidations.get(logicalGroups.find((g) => g.occurrenceIds.includes(rootOccurrence.occurrenceId))!.logicalId)!;
        const publicationResult = publishBases(publicationTargets, runState, { repoPath: rootConsolidation.canonicalRepoRoot, refName: rootConsolidation.integrationRef });
        if (!publicationResult.published) return true;
        const rawOutcomes: RawTaskRepoOutcome[] = sortedGroups.flatMap((group) => group.tasks.flatMap((task) => logicalGroups.map((logicalGroup) => ({
            taskNumber: task.number, repo: { repoName: logicalGroup.logicalId, status: "published" as const, commitHash: consolidations.get(logicalGroup.logicalId)!.preparedIntegrationOid },
        }))));
        const mergeResults = summarizeTaskMergeResults(rawOutcomes);
        archivePublishedTasks(sortedGroups.flatMap((group) => group.tasks.map((task) => task.number)), mergeResults, input.repo);
        for (const resolvePath of [resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath]) rmSync(resolvePath(input.repo), { force: true });
        const summaryTargets: PublicationTargetSummary[] = manifest.occurrences.map((occurrence) => {
            const group = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            const consolidation = consolidations.get(group.logicalId)!;
            return { repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath, recordedBaseOid: occurrence.baseOid, targetOid: consolidation.preparedIntegrationOid };
        });
        endMetrics(0);
        printResult(summaryTargets);
        return false;
    });
    if (aborted) { endMetrics(conflicts.length + 1); printResult([]); }
}
```

Line count, measured: **249** (identical to the file's current line count — the extraction into
`baseDrift.ts` paid for the new reconciliation/fetch line exactly). Confirm with `wc -l
scripts/mergePipeline.ts`.

What changed vs. the current file, summarized (everything else is byte-identical): the `baseDrift.ts`
import; `SubmoduleConflict`/`MergeOutcome` each gain `baseDrift: BaseDriftResult | null`; the
`parseMergeTreeConflicts` function is deleted (moved into `probeMergeTreeConflicts` in
`baseDrift.ts`); one `computeDriftByGroup` call plus one reconcile-and-fetch loop are inserted right
after `rawTips` is built and right before `baseMismatch`; the merge-tree try/catch inside the probe
loop is replaced by a call to `probeMergeTreeConflicts`, and both outcome-construction sites gain a
`baseDrift` field. `digestInput.baseRef`, every `consolidationInput.recordedBaseOid`, the post-push
CAS check, and `summaryTargets` are **not edited** — they already read `occurrence.baseOid` /
`canonicalOccurrence.baseOid` by reference and pick up the reconciliation automatically.

### 5. `scripts/mergeTaskWorktrees.ts` — 3 edits

**Edit 5a — import the new module.** Current text:

```
import { type PreparedGroup, type WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
```

becomes:

```
import { type PreparedGroup, type WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { checkBaseDrift, readDestinationTip, type BaseDriftResult } from "./baseDrift.ts";
```

**Edit 5b — rewrite `mergeGroupBranchIntoRepo`.** Current text:

```
export function mergeGroupBranchIntoRepo(
    repoRoot: string,
    group: PreparedGroup,
    sourceBranch: string,
    submodulePaths: string[] = [],
): MergeOutcome {
    git(repoRoot, "checkout", sourceBranch);
    const outcome = { groupId: group.groupId, submoduleConflicts: [], worktree: group.worktree };
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", `merge ${group.branch}`);
        return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
    } catch (error) {
        const resolution = resolveGitlinkConflicts(repoRoot, submodulePaths);
        if (resolution.resolved) return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
        const failureReason = resolution.startFailed ? gitErrorText(error) : null;
        return { ...outcome, merged: false, conflictedFilePaths: resolution.unexpectedConflicts, failureReason };
    }
}
```

becomes:

```
// Orphaned-worktree recovery: rebases onto the live destination when needed, then merges.
export function mergeGroupBranchIntoRepo(
    repoRoot: string,
    group: PreparedGroup,
    sourceBranch: string,
    submodulePaths: string[] = [],
): MergeOutcome {
    const destTip = readDestinationTip(repoRoot, sourceBranch);
    const currentTip = git(group.worktree, "rev-parse", "HEAD").trim();
    // ponytail: caught-up is re-derived from ancestry, not tracked; a second drift between attempts needs a fresh forkPoint.
    const caughtUp = checkBaseDrift(group.worktree, destTip, currentTip).status !== "diverged";
    let baseDrift: BaseDriftResult | null = null;
    if (!caughtUp) {
        let forkPoint = group.forkPoints?.find((fp) => fp.repositoryPath === "")?.oid;
        if (!forkPoint) {
            try {
                // Legacy fallback: an orphaned worktree recovered without a persisted forkPoints entry.
                forkPoint = git(repoRoot, "merge-base", group.branch, sourceBranch).trim();
            } catch (error) {
                return { groupId: group.groupId, merged: false, conflictedFilePaths: [], submoduleConflicts: [], worktree: group.worktree, failureReason: `could not determine a fork point for drift detection: ${gitErrorText(error)}`, baseDrift: null };
            }
        }
        const drift = checkBaseDrift(repoRoot, forkPoint, destTip);
        baseDrift = drift.status === "none" ? null : drift;
        if (baseDrift) {
            try {
                git(group.worktree, "rebase", "--onto", destTip, forkPoint);
            } catch (error) {
                const conflictedFilePaths = git(group.worktree, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
                return { groupId: group.groupId, merged: false, conflictedFilePaths, submoduleConflicts: [], worktree: group.worktree, failureReason: gitErrorText(error), baseDrift };
            }
        }
    }
    git(repoRoot, "checkout", sourceBranch);
    const outcome = { groupId: group.groupId, submoduleConflicts: [], worktree: group.worktree, baseDrift };
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", `merge ${group.branch}`);
        return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
    } catch (error) {
        const resolution = resolveGitlinkConflicts(repoRoot, submodulePaths);
        if (resolution.resolved) return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
        const failureReason = resolution.startFailed ? gitErrorText(error) : null;
        return { ...outcome, merged: false, conflictedFilePaths: resolution.unexpectedConflicts, failureReason };
    }
}
```

Why "already caught up" is derived from ancestry (`destTip` reachable from `currentTip`) rather than
by re-checking the stale `forkPoint` on every call: after a human/agent resolves a rebase conflict by
hand (`git add` + `git rebase --continue`), the group branch's HEAD becomes a descendant of `destTip`,
so a retry correctly skips straight to the merge — verified with a dedicated test that calls the
function twice, resolving the conflict between calls. Checking only the stale `forkPoint` would retry
the identical rebase forever, since `forkPoint` never changes.

**Edit 5c — give the synthetic `runMergeCli` group an empty `forkPoints`.** Current text:

```
    const group: PreparedGroup = { groupId: 0, worktree: worktreePath, branch, scope: "unknown", tasks: [] };
```

becomes:

```
    const group: PreparedGroup = { groupId: 0, worktree: worktreePath, branch, scope: "unknown", forkPoints: [], tasks: [] };
```

(`forkPoints: []` means `mergeGroupBranchIntoRepo` always falls through to the `git merge-base`
legacy fallback for this CLI path, which is correct: an orphaned worktree recovered via `--merge`
never had a persisted `PreparedGroup` to read.)

Line count after all 3 edits, measured: **243** (was 215). No split needed.

### 6. `skills/tackle-tasks/merge.workflow.js` — 2 edits

**Edit 6a — teach the unblock agent to rebase on drift before resolving.** Current text:

```
for each conflict in report.conflicts:
    if conflict.submoduleConflicts is not empty:
        run scripts/resolveGitlinkConflicts against conflict.worktree
    else if conflict.conflictedFilePaths is not empty:
        for each path in conflict.conflictedFilePaths:
            resolve path in conflict.worktree, keeping BOTH sides' intent
        stage only those paths, then commit
```

becomes:

```
for each conflict in report.conflicts:
    if conflict.baseDrift is present and conflict.baseDrift.status is not "none":
        rebase conflict.worktree onto conflict.baseDrift.destTip, starting from conflict.baseDrift.forkPoint
        // this rewrites the TASK branch checked out in conflict.worktree; the destination is untouched
        if the rebase reports conflicted paths:
            resolve each conflicted path in conflict.worktree, keeping BOTH sides' intent
            stage only those paths, then continue the rebase
            repeat resolve-then-continue until the rebase reports it is complete
            // if judgement is needed mid-rebase, abort the rebase first (see the decisions step below)
    for each submoduleConflict in conflict.submoduleConflicts:
        if submoduleConflict.baseDrift is present and submoduleConflict.baseDrift.status is not "none":
            rebase (conflict.worktree + "/" + submoduleConflict.path) onto submoduleConflict.baseDrift.destTip,
            starting from submoduleConflict.baseDrift.forkPoint, with the same resolve-then-continue loop
    if conflict.submoduleConflicts is not empty:
        run scripts/resolveGitlinkConflicts against conflict.worktree
    else if conflict.conflictedFilePaths is not empty:
        for each path in conflict.conflictedFilePaths:
            resolve path in conflict.worktree, keeping BOTH sides' intent
        stage only those paths, then commit
```

**Edit 6b — reword the forbidden-actions paragraph to carve out the task branch.** Current text:

```
You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset anything you did not create; to run
failedCommand yourself; or to decide anything in decisions on the user's
behalf. Each entry in decisions must be answerable without opening the repo.
Returning a decision is a correct outcome, not a failure.`
```

becomes:

```
You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset the destination branch, or anything
you did not create outside of it; to run failedCommand yourself; or to
decide anything in decisions on the user's behalf. Rebasing the TASK branch
(conflict.worktree, or a submodule checkout inside it) is permitted, and
expected, whenever a baseDrift field calls for it — the destination branch
is the only branch that must never be rewritten, force-pushed, or hard-reset.
Each entry in decisions must be answerable without opening the repo.
Returning a decision is a correct outcome, not a failure.`
```

(The trailing backtick on the last line closes the `diagnoseBrief` template literal — preserve it
exactly. Neither edit introduces a literal backtick character, so the enclosing template literal is
not terminated early.)

Line count after both edits, measured: **129** (was 114).

### 7. `tests/mergeTaskWorktrees.test.ts` — 3 edits

**Edit 7a — import `buildWorkflowArguments` alongside the existing imports.** Current text (top of
file):

```
import { createWorktreeForGroup, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "../scripts/prepareTasks.ts";
```

becomes:

```
import { buildWorkflowArguments, createWorktreeForGroup, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "../scripts/prepareTasks.ts";
```

**Edit 7b — capture a root fork point in the `makeGroup` test helper.** Current text:

```
function makeGroup(repoRoot: string, groupId: number): PreparedGroup {
    const worktree = createWorktreeForGroup(repoRoot, { groupId, taskNumbers: [groupId], filePaths: [], scope: "unknown" });
    return { groupId, worktree, branch: `task-group-${groupId}`, scope: "unknown", tasks: [] };
}
```

becomes:

```
function makeGroup(repoRoot: string, groupId: number): PreparedGroup {
    const worktree = createWorktreeForGroup(repoRoot, { groupId, taskNumbers: [groupId], filePaths: [], scope: "unknown" });
    const forkPoints = [{ repositoryPath: "", oid: git(worktree, "rev-parse", "HEAD").trim() }];
    return { groupId, worktree, branch: `task-group-${groupId}`, scope: "unknown", forkPoints, tasks: [] };
}
```

**Edit 7c — fix `test_publicationFailureLeavesTaskOpenAndKeepsRunFilesWhileSuccessArchives`'s
"raced" scenario, which currently encodes the old abort-on-any-drift behavior.** Current text:

```
test("test_publicationFailureLeavesTaskOpenAndKeepsRunFilesWhileSuccessArchives", () => {
    // Another writer moves the base ref after the manifest is captured, so publication must refuse.
    const raced = buildNestedFixtureWithTask(9101);
    writeFileSync(join(raced.rootPath, "raced.txt"), "another writer\n");
    git(raced.rootPath, "add", "raced.txt");
    git(raced.rootPath, "commit", "-q", "-m", "someone else moved the base");

    assert.deepEqual(runPipelineCli(raced.cliInput).publicationTargets, []);
    assert.deepEqual(readTaskNumbers(raced.taskToolsDir, "tasks.json"), [9101]);
    assert.deepEqual(readTaskNumbers(raced.taskToolsDir, "completedTasks.json"), []);
    for (const path of raced.runFiles) assert.equal(existsSync(path), true);
```

becomes:

```
test("test_publicationFailureLeavesTaskOpenAndKeepsRunFilesWhileSuccessArchives", () => {
    // Drift alone now reconciles; drift plus a real content conflict on the same path still refuses.
    const raced = buildNestedFixtureWithTask(9101);
    writeFileSync(join(raced.rootPath, "new.txt"), "someone else's new.txt\n");
    git(raced.rootPath, "add", "new.txt");
    git(raced.rootPath, "commit", "-q", "-m", "someone else moved the base with a conflicting edit");

    const racedOutput = runPipelineCli(raced.cliInput) as { publicationTargets: unknown[]; conflicts: { baseDrift: { status: string } | null }[] };
    assert.deepEqual(racedOutput.publicationTargets, []);
    assert.equal(racedOutput.conflicts[0].baseDrift?.status, "advanced");
    assert.deepEqual(readTaskNumbers(raced.taskToolsDir, "tasks.json"), [9101]);
    assert.deepEqual(readTaskNumbers(raced.taskToolsDir, "completedTasks.json"), []);
    for (const path of raced.runFiles) assert.equal(existsSync(path), true);
```

The rest of the test (the "clean" half, starting at `// Nothing races the base ref...`) is unchanged.
`buildNestedFixtureWithTask`'s group already adds `new.txt` to the root worktree, so writing a
*different* `new.txt` to `raced.rootPath` is a genuine add/add conflict on the same path — the run
still refuses, now because of a real conflict rather than mere base movement, which is exactly what
this task changes.

**Edit 7d — append 8 new tests** after the file's last existing test
(`test_publicationFailureLeavesTaskOpenAndKeepsRunFilesWhileSuccessArchives`, ending in `});`). All
were run individually and together; all pass.

```ts

test("test_buildWorkflowArgumentsCapturesEachGroupsForkPointAtWorktreeCreationTime", () => {
    const repoRoot = makeTempRepoWithCommit();
    const expectedForkPoint = git(repoRoot, "rev-parse", "HEAD").trim();
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", [
        { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" },
    ]);
    const rootForkPoint = workflowArguments.groups[0].forkPoints?.find((fp) => fp.repositoryPath === "");
    assert.equal(rootForkPoint?.oid, expectedForkPoint);
});

test("test_buildWorkflowArgumentsCapturesTheSubmodulesForkPointToo", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const expectedSubmoduleForkPoint = git(join(repoRoot, "vendor"), "rev-parse", "HEAD").trim();
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", [
        { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" },
    ]);
    const submoduleForkPoint = workflowArguments.groups[0].forkPoints?.find((fp) => fp.repositoryPath === "vendor");
    assert.equal(submoduleForkPoint?.oid, expectedSubmoduleForkPoint);
});

test("test_runPipelineCliReconcilesDriftWithNoConflictAndPublishesAgainstTheNewTip", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    writeFileSync(join(repoRoot, "unrelated.txt"), "unrelated\n");
    git(repoRoot, "add", "unrelated.txt");
    git(repoRoot, "commit", "-q", "-m", "destination advances with an unrelated change");
    const destTip = git(repoRoot, "rev-parse", sourceBranch).trim();
    const forkPoint = group.forkPoints![0].oid;

    const cliInput = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [{ path: "", sourceBranch }],
        repositoryManifest: makeManifest(sourceBranch, forkPoint, group.branch),
        testReceipts: [{ groupId: "1", status: "green" }],
        reviewHandoffs: ["reviewed by codex"],
    };
    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });
    const output = JSON.parse(stdout);

    assert.equal(output.runState.readyForApproval, true);
    assert.equal(output.merged[0].baseDrift.status, "advanced");
    assert.equal(output.merged[0].baseDrift.destTip, destTip);
    const rootTarget = output.publicationTargets.find((t: { repositoryPath: string }) => t.repositoryPath === "");
    assert.equal(rootTarget.recordedBaseOid, destTip);
});

test("test_runPipelineCliReconcilesSubmoduleDriftIndependentlyOfTheRootOccurrence", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const sourceBranch = currentBranchName(repoRoot);
    const submoduleSourceBranch = currentBranchName(mainSubmodulePath);
    const group = makeGroup(repoRoot, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const submoduleGroupBranch = currentBranchName(worktreeSubmodulePath);
    const rootForkPoint = group.forkPoints![0].oid;
    const submoduleForkPoint = git(worktreeSubmodulePath, "rev-parse", "HEAD").trim();
    group.forkPoints!.push({ repositoryPath: "vendor", oid: submoduleForkPoint });

    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    writeFileSync(join(worktreeSubmodulePath, "vendor-new.txt"), "vendor new\n");
    git(worktreeSubmodulePath, "add", "vendor-new.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "add vendor-new.txt");

    // Only the submodule's destination advances; the root destination does not.
    writeFileSync(join(mainSubmodulePath, "unrelated.txt"), "unrelated\n");
    git(mainSubmodulePath, "add", "unrelated.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "submodule destination advances");
    const submoduleDestTip = git(mainSubmodulePath, "rev-parse", submoduleSourceBranch).trim();

    const testReceipts = [{ groupId: "1", status: "green" }];
    const reviewHandoffs = ["reviewed by codex"];
    const cliInput = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [group],
        repositorySources: [
            { path: "", sourceBranch },
            { path: "vendor", sourceBranch: submoduleSourceBranch },
        ],
        repositoryManifest: makeManifest(sourceBranch, rootForkPoint, group.branch, [
            { checkoutPath: "vendor", baseBranch: submoduleSourceBranch, baseOid: submoduleForkPoint, operationBranch: submoduleGroupBranch },
        ]),
        testReceipts,
        reviewHandoffs,
    };
    const stdout = execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(cliInput)], { encoding: "utf8" });
    const output = JSON.parse(stdout);

    assert.equal(output.runState.readyForApproval, true);
    const rootTarget = output.publicationTargets.find((t: { repositoryPath: string }) => t.repositoryPath === "");
    const subTarget = output.publicationTargets.find((t: { repositoryPath: string }) => t.repositoryPath === "vendor");
    assert.equal(rootTarget.recordedBaseOid, rootForkPoint);
    assert.equal(subTarget.recordedBaseOid, submoduleDestTip);
});

test("test_mergeGroupBranchIntoRepoRebasesOntoADivergedDestinationWithNoConflictThenMerges", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    // Rewrite the destination onto an unrelated history: not a descendant of the recorded fork point.
    git(repoRoot, "checkout", "-q", "--orphan", "rewritten");
    writeFileSync(join(repoRoot, "rewritten.txt"), "rewritten\n");
    git(repoRoot, "add", "rewritten.txt");
    git(repoRoot, "commit", "-q", "-m", "unrelated destination history");
    const unrelatedTip = git(repoRoot, "rev-parse", "HEAD").trim();
    git(repoRoot, "checkout", "-q", "-B", sourceBranch, unrelatedTip);

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.baseDrift?.status, "diverged");
    assert.equal(outcome.merged, true);
    assert.equal(existsSync(join(repoRoot, "new.txt")), true);
    assert.equal(existsSync(join(repoRoot, "rewritten.txt")), true);
});

test("test_mergeGroupBranchIntoRepoEntersARebaseOnConflictingDriftWithoutTouchingTheDestinationBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "seed.txt"), "from-worktree\n");
    git(group.worktree, "add", "seed.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "seed.txt"), "from-destination\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "destination edits the same line");
    const destTip = git(repoRoot, "rev-parse", sourceBranch).trim();

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, false);
    assert.deepEqual(outcome.conflictedFilePaths, ["seed.txt"]);
    assert.equal(outcome.baseDrift?.status, "advanced");
    assert.equal(git(repoRoot, "rev-parse", sourceBranch).trim(), destTip);
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
});

test("test_mergeGroupBranchIntoRepoSucceedsOnRetryAfterTheRebaseConflictIsResolvedByHand", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "seed.txt"), "from-worktree\n");
    git(group.worktree, "add", "seed.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "seed.txt"), "from-destination\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "destination edits the same line");

    const firstAttempt = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(firstAttempt.merged, false);

    // Resolve exactly as the unblock workflow would: keep both intents, stage, continue the rebase.
    writeFileSync(join(group.worktree, "seed.txt"), "from-worktree-and-destination\n");
    git(group.worktree, "add", "seed.txt");
    git(group.worktree, "-c", "core.editor=true", "rebase", "--continue");

    const retryOutcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(retryOutcome.merged, true);
    assert.equal(retryOutcome.baseDrift, null);
    assert.equal(readFileSync(join(repoRoot, "seed.txt"), "utf8"), "from-worktree-and-destination\n");
});

test("test_mergeGroupBranchIntoRepoReportsAStructuredBlockerWhenTheLegacyForkPointCannotBeDetermined", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    group.forkPoints = []; // simulates an orphaned worktree recovered without a persisted PreparedGroup

    // Make the group's branch and the destination share no common history at all.
    git(repoRoot, "checkout", "-q", "--orphan", "unrelated-destination");
    writeFileSync(join(repoRoot, "unrelated.txt"), "unrelated\n");
    git(repoRoot, "add", "unrelated.txt");
    git(repoRoot, "commit", "-q", "-m", "unrelated destination history");
    git(repoRoot, "checkout", "-q", "-B", sourceBranch, "HEAD");

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, false);
    assert.match(outcome.failureReason ?? "", /fork point/);
});
```

No existing test besides the one in edit 7c is edited — all other new coverage is additive. No new
top-level imports besides `buildWorkflowArguments` (edit 7a) are needed: `mergeGroupBranchIntoRepo`,
`makeManifest`, `git`, `execFileSync`, `writeFileSync`, `readFileSync`, `existsSync`, `join`, `assert`
are already imported.

## Files needing no edit (with reason)

- **`scripts/runMergePhase.ts`**: `MergeFailure.conflicts` is already typed `unknown[]` and
  `judgeMergeRun` only checks `output.conflicts?.length` — it never inspects individual conflict
  fields. The new `baseDrift` field on each `MergeOutcome`/`SubmoduleConflict` passes through
  unchanged. Confirmed `rg -n "MergeOutcome" scripts/runMergePhase.ts` only matches the unrelated
  `buildMergeOutcomes` function name, not the type.

## Verification

This plan was fully implemented and verified in a scratch sandbox (real copies of `scripts/`,
`tests/`, and `skills/`, the repo's own `tsconfig.json`, and `node --test`) before being written up.
Re-run the same checks from `/Users/matkatmusicllc/Programming/taskTools` after applying the edits:

1. `npx tsc --noEmit` — expect no type errors (confirmed clean against every file listed above,
   together, in the sandbox).
2. `node --test tests/baseDrift.test.ts` — expect 7/7 passing (confirmed).
3. `node --test tests/mergeTaskWorktrees.test.ts` — expect all passing: 18 pre-existing + 8 new = 26
   (confirmed 26/26).
4. `node --test tests/prepareTasks.test.ts tests/prepareTasksIntegration.test.ts
   tests/runMergePhase.test.ts tests/tackleMetrics.test.ts` — expect all passing, unchanged (confirmed
   42/42 in the sandbox; `tests/prepareTasks.test.ts`'s
   `test_selectRequestedTasksPointsAtTheUpdateTaskFilesSkillThatActuallyExists` will only pass in a
   full checkout, since it looks for `skills/update-task-files/SKILL.md` relative to the repo root —
   it failed only in the sandbox's initial partial copy, and passed once `skills/` was copied in too).
5. `wc -l scripts/mergePipeline.ts` — expect `249`.
6. `wc -l scripts/prepareTasks.ts` — expect `248`.
7. `wc -l scripts/mergeTaskWorktrees.ts` — expect `243`.
8. `wc -l scripts/baseDrift.ts` — expect `62`.
9. `node --test tests/*.test.ts` (full suite) — expect 1131/1131 in a full checkout. In the sandbox
   run this was 1128/1131; the 3 failures were `tests/reviewPlanBrief.test.ts` (references an absolute
   fixture path outside the sandbox), `tests/runStartup.test.ts` (checks `hooks/hooks.json`, a
   directory not copied into the sandbox), and `tests/runConsolidation.test.ts`'s
   `test_mergeOrderIsDeterministic` (a pre-existing hash-determinism test in a file this plan never
   touches — confirmed by grep that `runConsolidation.ts` is not among the files this plan edits). All
   three are artifacts of the sandbox being a partial copy, not regressions from this plan; a full
   checkout should show 1131/1131.
