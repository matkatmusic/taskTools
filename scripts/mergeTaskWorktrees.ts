// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { type PreparedGroup } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { runMergePipeline } from "./mergePipeline.ts";
import type { MergeOutcome } from "./mergePipeline.ts";
import { discoverRepositoryTree } from "./repositoryDiscovery.ts";
import type { DiscoveryManifest } from "./repositoryDiscovery.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
import { discoverTestPolicy } from "./testPolicy.ts";
import type { ResolutionManifest, ResolutionRequest } from "./resolutionRequests.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_EDITOR: "true" },
    });
}

function gitErrorText(error: unknown): string {
    const failure = error as { stderr?: string; message?: string };
    return (failure.stderr || failure.message || "git merge failed").trim();
}

export type TaskWorktree = { path: string; branch: string };

function parseWorktreeListPorcelain(output: string): TaskWorktree[] {
    const blocks = output.split("\n\n").map((block) => block.trim()).filter(Boolean);
    const worktrees: TaskWorktree[] = [];
    for (const block of blocks) {
        const lines = block.split("\n");
        const pathLine = lines.find((line) => line.startsWith("worktree "));
        const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
        if (!pathLine) continue;
        if (!branchLine) continue;
        worktrees.push({
            path: pathLine.slice("worktree ".length),
            branch: branchLine.slice("branch refs/heads/".length),
        });
    }
    return worktrees;
}

export function listTaskWorktrees(repoRoot: string): TaskWorktree[] {
    const conventionDir = join(tmpdir(), "taskTools-wt", basename(repoRoot));
    // git resolves symlinks in the paths it reports (e.g. macOS /var -> /private/var); match on the resolved form.
    if (!existsSync(conventionDir)) return [];
    const conventionRoot = realpathSync(conventionDir);
    const output = git(repoRoot, "worktree", "list", "--porcelain");
    return parseWorktreeListPorcelain(output).filter((worktree) => {
        if (!worktree.path.startsWith(`${conventionRoot}/`)) return false;
        return /^task-\d+$/.test(basename(worktree.path));
    });
}

function unmergedCommitCount(repoRoot: string, sourceBranch: string, branch: string): number {
    return Number(git(repoRoot, "rev-list", "--count", `${sourceBranch}..${branch}`).trim());
}

function commitChangedFiles(repoRoot: string, sourceBranch: string, branch: string): string[] {
    return git(repoRoot, "diff", "--name-only", `${sourceBranch}...${branch}`).split("\n").filter(Boolean);
}

// Porcelain v1 rename lines read "R  old -> new"; every other status line is "XY path".
export function uncommittedChangedFiles(worktreePath: string): string[] {
    return git(worktreePath, "status", "--porcelain").split("\n").filter(Boolean).map((line) => {
        const path = line.slice(3);
        if (!path.includes(" -> ")) return path;
        return path.split(" -> ")[1];
    });
}

export type UnmergedTaskWorktree = {
    worktree: string;
    branch: string;
    unmergedCommitCount: number;
    hasUncommittedChanges: boolean;
    changedFilePaths: string[];
    matchedTaskNumbers: number[];
};

export function findUnmergedTaskWorktrees(
    repoRoot: string,
    sourceBranch: string,
    openTasks: TaskRecord[],
): UnmergedTaskWorktree[] {
    const results = listTaskWorktrees(repoRoot).map((worktree) => {
        const commitChanged = commitChangedFiles(repoRoot, sourceBranch, worktree.branch);
        const uncommittedChanged = uncommittedChangedFiles(worktree.path);
        const changedFilePaths = [...new Set([...commitChanged, ...uncommittedChanged])];
        const matchedTaskNumbers = openTasks
            .filter((task) => declaredFiles(task).some((file) => changedFilePaths.includes(file)))
            .map((task) => task.taskNumber);
        return {
            worktree: worktree.path,
            branch: worktree.branch,
            unmergedCommitCount: unmergedCommitCount(repoRoot, sourceBranch, worktree.branch),
            hasUncommittedChanges: uncommittedChanged.length > 0,
            changedFilePaths,
            matchedTaskNumbers,
        };
    });
    return results.filter((r) => r.unmergedCommitCount > 0 || r.hasUncommittedChanges);
}

export type RebaseOutcome =
    | { status: "rebased-clean" }
    | { status: "conflicted"; conflictedFilePaths: string[] }
    | { status: "cleanup-failed"; failureReason: string };

function rebaseGitPath(worktreePath: string, relativePath: string): string {
    const output = git(worktreePath, "rev-parse", "--git-path", relativePath).trim();
    return isAbsolute(output) ? output : join(worktreePath, output);
}

export function rebaseInProgress(worktreePath: string): boolean {
    return existsSync(rebaseGitPath(worktreePath, "rebase-merge")) || existsSync(rebaseGitPath(worktreePath, "rebase-apply"));
}

function collectConflictedRebasePaths(worktreePath: string): string[] {
    return git(worktreePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
}

function abortRebase(worktreePath: string): { aborted: boolean; failureReason: string | null } {
    try {
        git(worktreePath, "rebase", "--abort");
        return { aborted: true, failureReason: null };
    } catch (error) {
        return { aborted: false, failureReason: gitErrorText(error) };
    }
}

function combineFailureReasons(...parts: (string | null)[]): string {
    return parts.filter((part): part is string => part !== null).join("; ");
}

export function rebaseGroupOntoSource(
    worktreePath: string,
    sourceBranch: string,
    submodulePathsAllowedToConflict: string[] = [],
    leaveConflictLive: boolean = false,
): RebaseOutcome {
    let pendingReason: string;
    try {
        git(worktreePath, "rebase", sourceBranch);
        return { status: "rebased-clean" };
    } catch (rebaseError) {
        pendingReason = gitErrorText(rebaseError);
    }

    while (true) {
        let inProgress: boolean;
        try {
            inProgress = rebaseInProgress(worktreePath);
        } catch (stateError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(pendingReason, gitErrorText(stateError), abortFailure) };
        }

        if (!inProgress) return { status: "cleanup-failed", failureReason: pendingReason };

        let conflictedFilePaths: string[];
        try {
            conflictedFilePaths = collectConflictedRebasePaths(worktreePath);
        } catch (collectionError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(pendingReason, gitErrorText(collectionError), abortFailure) };
        }

        // Every conflict in this round is an allowed submodule gitlink: stage the already-rebased commits and continue instead of aborting.
        const allConflictsAreAllowedSubmodules =
            conflictedFilePaths.length > 0 && conflictedFilePaths.every((path) => submodulePathsAllowedToConflict.includes(path));

        if (!allConflictsAreAllowedSubmodules) {
            // Live mode hands the caller the still-in-progress rebase and real conflict markers, instead of aborting first.
            if (conflictedFilePaths.length > 0 && leaveConflictLive) {
                return { status: "conflicted", conflictedFilePaths };
            }

            const abortResult = abortRebase(worktreePath);
            if (!abortResult.aborted) {
                return { status: "cleanup-failed", failureReason: combineFailureReasons(pendingReason, `abort also failed: ${abortResult.failureReason}`) };
            }

            if (conflictedFilePaths.length === 0) return { status: "cleanup-failed", failureReason: pendingReason };

            return { status: "conflicted", conflictedFilePaths };
        }

        try {
            for (const path of conflictedFilePaths) git(worktreePath, "add", path);
        } catch (stagingError) {
            // A failed `git add` leaves the same conflict in place: abort immediately, never loop on it.
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(pendingReason, gitErrorText(stagingError), abortFailure) };
        }

        try {
            git(worktreePath, "rebase", "--continue");
            return { status: "rebased-clean" };
        } catch (continueError) {
            // Only a failed `git rebase --continue` loops: it may mean a later commit hit another conflict.
            pendingReason = combineFailureReasons(pendingReason, gitErrorText(continueError));
        }
    }
}

export type FailedCheck = "typecheck" | "complete-suite";

export type SubmoduleLayerOutcome =
    | { occurrenceId: string; checkoutPath: string; status: "no-op" }
    | { occurrenceId: string; checkoutPath: string; status: "rebased-and-tested" }
    | { occurrenceId: string; checkoutPath: string; status: "conflicted"; conflictedFilePaths: string[] }
    | { occurrenceId: string; checkoutPath: string; status: "cleanup-failed"; failureReason: string }
    | { occurrenceId: string; checkoutPath: string; status: "tests-failed"; failedCheck: FailedCheck; testOutput: string }
    | { occurrenceId: string; checkoutPath: string; status: "untested"; resolutionRequests: ResolutionRequest[] }
    | { occurrenceId: string; checkoutPath: string; status: "source-sync-failed"; failureReason: string };

// "rebased-and-tested" also covers a layer whose own branch was already current but whose child gitlink changed.

export type SubmoduleLayerWalkReport = {
    completedLayers: SubmoduleLayerOutcome[];
    stoppedAt: SubmoduleLayerOutcome | null;
};

function testFailureOutput(error: unknown): string {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return [failure.stdout, failure.stderr].filter(Boolean).join("\n").trim() || failure.message || "test command failed";
}

// Fetches baseBranch fresh from the real source checkout, without touching whatever branch is checked out.
function fetchBaseBranchFromSource(checkoutPath: string, sourceCheckoutPath: string, baseBranch: string): void {
    git(checkoutPath, "fetch", sourceCheckoutPath, `${baseBranch}:${baseBranch}`);
}

// Which of occurrence's direct children have a gitlink in occurrence's tree that no longer matches their checked-out commit.
function changedChildGitlinkPaths(occurrence: RepositoryOccurrence, childrenByParentId: Map<string, RepositoryOccurrence[]>): string[] {
    const children = childrenByParentId.get(occurrence.occurrenceId) ?? [];
    return children
        .map((child) => child.pathInParent)
        .filter((pathInParent): pathInParent is string => pathInParent !== null)
        .filter((pathInParent) => git(occurrence.checkoutPath, "status", "--porcelain", "--", pathInParent).trim() !== "");
}

// Stages and commits the gitlink bump for every already-computed changed child path. No-op when the list is empty.
function recordRebasedChildGitlinks(occurrence: RepositoryOccurrence, changedChildPaths: string[]): void {
    if (changedChildPaths.length === 0) return;
    for (const pathInParent of changedChildPaths) git(occurrence.checkoutPath, "add", pathInParent);
    git(occurrence.checkoutPath, "commit", "-q", "-m", `record rebased submodule commit: ${changedChildPaths.join(", ")}`);
}

function rebaseAndTestSubmoduleLayer(
    occurrence: RepositoryOccurrence,
    sourceCheckoutPath: string,
    resolutionManifest: ResolutionManifest,
    childrenByParentId: Map<string, RepositoryOccurrence[]>,
    leaveConflictLive: boolean = false,
    typecheckCommand: string | null = null,
): SubmoduleLayerOutcome {
    const { occurrenceId, checkoutPath, baseBranch, operationBranch } = occurrence;

    try {
        fetchBaseBranchFromSource(checkoutPath, sourceCheckoutPath, baseBranch);
    } catch (error) {
        return { occurrenceId, checkoutPath, status: "source-sync-failed", failureReason: gitErrorText(error) };
    }

    const aheadOfSource = unmergedCommitCount(checkoutPath, baseBranch, operationBranch);
    const behindSource = unmergedCommitCount(checkoutPath, operationBranch, baseBranch);
    const refsIdentical = aheadOfSource === 0 && behindSource === 0;
    const changedChildPaths = changedChildGitlinkPaths(occurrence, childrenByParentId);

    // Refs identical and no child gitlink changed: nothing for this layer to do at all.
    if (refsIdentical && changedChildPaths.length === 0) {
        return { occurrenceId, checkoutPath, status: "no-op" };
    }

    // Refs differ: rebase this layer's own branch. Refs identical but a child changed: skip the rebase entirely.
    if (!refsIdentical) {
        const rebaseOutcome = rebaseGroupOntoSource(checkoutPath, baseBranch, [], leaveConflictLive);
        if (rebaseOutcome.status === "conflicted") {
            return { occurrenceId, checkoutPath, status: "conflicted", conflictedFilePaths: rebaseOutcome.conflictedFilePaths };
        }
        if (rebaseOutcome.status === "cleanup-failed") {
            return { occurrenceId, checkoutPath, status: "cleanup-failed", failureReason: rebaseOutcome.failureReason };
        }
    }

    // Either the rebase above just happened, or refs were identical but a child's gitlink still needs recommitting.
    recordRebasedChildGitlinks(occurrence, changedChildPaths);

    if (typecheckCommand !== null) {
        try {
            execSync(typecheckCommand, { cwd: checkoutPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
            return { occurrenceId, checkoutPath, status: "tests-failed", failedCheck: "typecheck", testOutput: testFailureOutput(error) };
        }
    }

    const testPolicyResult = discoverTestPolicy(occurrenceId, checkoutPath, resolutionManifest);
    if (testPolicyResult.status === "needsResolution") {
        return { occurrenceId, checkoutPath, status: "untested", resolutionRequests: testPolicyResult.resolutionRequests };
    }

    try {
        execSync(testPolicyResult.policy.completeSuiteCommand, { cwd: checkoutPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { occurrenceId, checkoutPath, status: "rebased-and-tested" };
    } catch (error) {
        return { occurrenceId, checkoutPath, status: "tests-failed", failedCheck: "complete-suite", testOutput: testFailureOutput(error) };
    }
}

function groupChildrenByParentId(occurrences: RepositoryOccurrence[]): Map<string, RepositoryOccurrence[]> {
    const childrenByParentId = new Map<string, RepositoryOccurrence[]>();
    for (const occurrence of occurrences) {
        if (occurrence.parentOccurrenceId === null) continue;
        const siblings = childrenByParentId.get(occurrence.parentOccurrenceId) ?? [];
        siblings.push(occurrence);
        childrenByParentId.set(occurrence.parentOccurrenceId, siblings);
    }
    return childrenByParentId;
}

// Rebases each submodule deepest-first, testing every layer before moving up; stops on the first red layer.
export function rebaseSubmoduleLayersDeepestFirst(worktreePath: string, manifest: DiscoveryManifest, leaveConflictLive: boolean = false, typecheckCommand: string | null = null): SubmoduleLayerWalkReport {
    const sourceCheckoutPathByOccurrenceId = new Map(
        manifest.repositoryManifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence.checkoutPath]),
    );

    const discovery = discoverRepositoryTree(worktreePath, manifest);
    if (discovery.status === "needsResolution") {
        throw new Error(`repository tree discovery needs resolution for: ${discovery.resolutionRequests.map((request) => request.occurrenceId).join(", ")}`);
    }

    const submoduleOccurrences = discovery.graph.filter((occurrence) => occurrence.parentOccurrenceId !== null);
    const childrenByParentId = groupChildrenByParentId(submoduleOccurrences);
    const submoduleLayersDeepestFirst = [...submoduleOccurrences].sort((a, b) => b.depth - a.depth);

    const completedLayers: SubmoduleLayerOutcome[] = [];
    for (const occurrence of submoduleLayersDeepestFirst) {
        const sourceCheckoutPath = sourceCheckoutPathByOccurrenceId.get(occurrence.occurrenceId) ?? "";
        let outcome: SubmoduleLayerOutcome;
        try {
            outcome = rebaseAndTestSubmoduleLayer(occurrence, sourceCheckoutPath, manifest.resolutionManifest, childrenByParentId, leaveConflictLive, typecheckCommand);
        } catch (error) {
            // An unexpected operational failure (e.g. a rejected commit hook) must not discard already-completed layers.
            return { completedLayers, stoppedAt: { occurrenceId: occurrence.occurrenceId, checkoutPath: occurrence.checkoutPath, status: "cleanup-failed", failureReason: gitErrorText(error) } };
        }
        if (outcome.status !== "no-op" && outcome.status !== "rebased-and-tested") {
            return { completedLayers, stoppedAt: outcome };
        }
        completedLayers.push(outcome);
    }
    return { completedLayers, stoppedAt: null };
}

export type ParentRebaseOutcome =
    | { status: "rebased-and-tested" }
    | { status: "conflicted"; conflictedFilePaths: string[] }
    | { status: "cleanup-failed"; failureReason: string }
    | { status: "tests-failed"; failedCheck: FailedCheck; testOutput: string }
    | { status: "untested"; resolutionRequests: ResolutionRequest[] };

// Rebases the parent's task-N branch onto its source tip, resolving submodule gitlink conflicts, then tests it.
export function rebaseParentOntoSourceAndTest(
    occurrenceId: string,
    worktreePath: string,
    sourceBranch: string,
    submodulePaths: string[],
    resolutionManifest: ResolutionManifest,
    leaveConflictLive: boolean = false,
    typecheckCommand: string | null = null,
): ParentRebaseOutcome {
    const rebaseOutcome = rebaseGroupOntoSource(worktreePath, sourceBranch, submodulePaths, leaveConflictLive);
    if (rebaseOutcome.status === "conflicted") {
        return { status: "conflicted", conflictedFilePaths: rebaseOutcome.conflictedFilePaths };
    }
    if (rebaseOutcome.status === "cleanup-failed") {
        return { status: "cleanup-failed", failureReason: rebaseOutcome.failureReason };
    }

    if (typecheckCommand !== null) {
        try {
            execSync(typecheckCommand, { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        } catch (error) {
            return { status: "tests-failed", failedCheck: "typecheck", testOutput: testFailureOutput(error) };
        }
    }

    const testPolicyResult = discoverTestPolicy(occurrenceId, worktreePath, resolutionManifest);
    if (testPolicyResult.status === "needsResolution") {
        return { status: "untested", resolutionRequests: testPolicyResult.resolutionRequests };
    }

    try {
        execSync(testPolicyResult.policy.completeSuiteCommand, { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { status: "rebased-and-tested" };
    } catch (error) {
        return { status: "tests-failed", failedCheck: "complete-suite", testOutput: testFailureOutput(error) };
    }
}

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

export function resolveGitlinkConflicts(
    repoRoot: string,
    submodulePaths: string[],
): { resolved: boolean; unexpectedConflicts: string[]; startFailed: boolean } {
    const conflictedPaths = git(repoRoot, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    // No unmerged paths means the merge never started, so there is nothing to abort, stage, or commit.
    if (conflictedPaths.length === 0) return { resolved: false, unexpectedConflicts: [], startFailed: true };
    const unexpectedConflicts = conflictedPaths.filter((path) => !submodulePaths.includes(path));
    if (unexpectedConflicts.length > 0) {
        git(repoRoot, "merge", "--abort");
        return { resolved: false, unexpectedConflicts, startFailed: false };
    }
    for (const path of conflictedPaths) git(repoRoot, "add", path);
    git(repoRoot, "commit", "--no-edit");
    return { resolved: true, unexpectedConflicts: [], startFailed: false };
}

export function mergeSubmoduleBranchIntoRepo(
    mainSubmodulePath: string,
    worktreeSubmodulePath: string,
    sourceBranch: string,
): { merged: boolean; conflictedFilePaths: string[]; failureReason: string | null } {
    const groupBranch = currentBranchName(worktreeSubmodulePath);
    git(mainSubmodulePath, "fetch", worktreeSubmodulePath, `${groupBranch}:refs/heads/${groupBranch}`);
    git(mainSubmodulePath, "checkout", sourceBranch);
    try {
        git(mainSubmodulePath, "merge", "--no-ff", groupBranch, "-m", `merge ${groupBranch}`);
        return { merged: true, conflictedFilePaths: [], failureReason: null };
    } catch (error) {
        const conflictedFilePaths = git(mainSubmodulePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
        // Same rule as the parent repo: with no unmerged paths there is no merge in progress to abort.
        if (conflictedFilePaths.length === 0) return { merged: false, conflictedFilePaths, failureReason: gitErrorText(error) };
        git(mainSubmodulePath, "merge", "--abort");
        return { merged: false, conflictedFilePaths, failureReason: null };
    }
}

export function removeWorktreeAndBranch(repoRoot: string, worktreePath: string, branchName: string): void {
    // existsSync guard makes this idempotent after a partially completed prior cleanup (C86-28).
    if (existsSync(worktreePath)) git(repoRoot, "worktree", "remove", worktreePath, "--force");
    deleteLocalBranchIfPresent(repoRoot, branchName);
}

function deleteLocalBranchIfPresent(repoRoot: string, branchName: string): void {
    try {
        git(repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`);
    } catch {
        return; // idempotent after a partially completed prior cleanup
    }
    git(repoRoot, "branch", "-D", branchName);
}

export type SourceBranchCleanupTarget = {
    checkoutPath: string;
    depth: number;
};

// Close has already succeeded: delete canonical source-submodule refs deepest-first, then remove the root task worktree/branch last.
export function removeTaskWorktreeAndBranches(
    repoRoot: string,
    worktreePath: string,
    branchName: string,
    sourceSubmodules: SourceBranchCleanupTarget[],
): void {
    for (const target of [...sourceSubmodules].sort((a, b) => b.depth - a.depth)) {
        deleteLocalBranchIfPresent(target.checkoutPath, branchName);
    }
    removeWorktreeAndBranch(repoRoot, worktreePath, branchName);
}

export type MergeStepOperations = {
    mergeSubmodule: (mainSubmodulePath: string, worktreeSubmodulePath: string, sourceBranch: string) => { merged: boolean; conflictedFilePaths: string[]; failureReason: string | null };
    mergeGroup: (repoRoot: string, group: PreparedGroup, sourceBranch: string, submodulePaths: string[]) => MergeOutcome;
};

export const defaultMergeStepOperations: MergeStepOperations = {
    mergeSubmodule: mergeSubmoduleBranchIntoRepo,
    mergeGroup: mergeGroupBranchIntoRepo,
};

function displayOccurrenceId(occurrenceId: string): string {
    return occurrenceId === "" ? "root" : occurrenceId;
}

function mergedCommitRefName(operationBranch: string): string {
    return `refs/taskTools/merged-commits/${operationBranch}`;
}

function mergeIntentRefName(operationBranch: string): string {
    return `refs/taskTools/merge-intents/${operationBranch}`;
}

// Written before the real merge; a survivor means the process died mid-merge.
function recordMergeIntent(repoRoot: string, operationBranch: string, operationOid: string): void {
    git(repoRoot, "update-ref", mergeIntentRefName(operationBranch), operationOid);
}

function clearMergeIntent(repoRoot: string, operationBranch: string): void {
    git(repoRoot, "update-ref", "-d", mergeIntentRefName(operationBranch));
}

// Called only after landing: a surviving intent ref just makes a future retry more cautious.
function clearMergeIntentBestEffort(repoRoot: string, operationBranch: string): void {
    try {
        clearMergeIntent(repoRoot, operationBranch);
    } catch {
        // intentionally ignored
    }
}

// Records the merge commit at merge time so a later retry's no-op path reuses it instead of guessing.
function recordMergedCommit(repoRoot: string, operationBranch: string, mergedOid: string): void {
    git(repoRoot, "update-ref", mergedCommitRefName(operationBranch), mergedOid);
}

function readOptionalRef(repoRoot: string, refName: string): string | null {
    try {
        return git(repoRoot, "rev-parse", "--verify", refName).trim();
    } catch {
        return null;
    }
}

// A recorded merge-commit ref proves a merge landed even if the driver that recorded it never returned (C86-21).
export function findRecordedMergedCommit(repoRoot: string, operationBranch: string): string | null {
    return readOptionalRef(repoRoot, mergedCommitRefName(operationBranch));
}

// Deletes both persistence refs; safe to call on refs that are already absent.
export function deleteTaskMergePersistence(repoRoot: string, operationBranch: string): void {
    if (readOptionalRef(repoRoot, mergedCommitRefName(operationBranch)) !== null) {
        git(repoRoot, "update-ref", "-d", mergedCommitRefName(operationBranch));
    }
    if (readOptionalRef(repoRoot, mergeIntentRefName(operationBranch)) !== null) {
        git(repoRoot, "update-ref", "-d", mergeIntentRefName(operationBranch));
    }
}

function refExists(repoRoot: string, refName: string): boolean {
    return readOptionalRef(repoRoot, refName) !== null;
}

export type RetainedArtifactTarget = {
    worktreePath: string;
    leasePath: string;
    mainRepoRoot: string;
    branch: string;
    sourceSubmodules: SourceBranchCleanupTarget[];
};

// Reports only artifacts a failed cleanup actually left behind, across the lease and every repo (C86-28).
export function collectRetainedTaskArtifacts(target: RetainedArtifactTarget): string[] {
    const artifacts: string[] = [];
    if (existsSync(target.worktreePath)) artifacts.push(target.worktreePath);
    if (existsSync(target.leasePath)) artifacts.push(target.leasePath);
    if (refExists(target.mainRepoRoot, `refs/heads/${target.branch}`)) artifacts.push(`refs/heads/${target.branch}`);
    if (refExists(target.mainRepoRoot, mergedCommitRefName(target.branch))) artifacts.push(mergedCommitRefName(target.branch));
    if (refExists(target.mainRepoRoot, mergeIntentRefName(target.branch))) artifacts.push(mergeIntentRefName(target.branch));
    for (const submodule of [...target.sourceSubmodules].sort((a, b) => b.depth - a.depth)) {
        if (refExists(submodule.checkoutPath, `refs/heads/${target.branch}`)) {
            artifacts.push(`${submodule.checkoutPath}:refs/heads/${target.branch}`);
        }
        if (refExists(submodule.checkoutPath, mergedCommitRefName(target.branch))) {
            artifacts.push(`${submodule.checkoutPath}:${mergedCommitRefName(target.branch)}`);
        }
        if (refExists(submodule.checkoutPath, mergeIntentRefName(target.branch))) {
            artifacts.push(`${submodule.checkoutPath}:${mergeIntentRefName(target.branch)}`);
        }
    }
    return artifacts;
}

export type MergeLayerOutcome =
    | {
          occurrenceId: string;
          checkoutPath: string;
          status: "no-op";
          // Current source tip: used only for child-gitlink propagation.
          oid: string;
          // Historical task merge commit: used for close/archive; null for an untouched layer.
          mergedCommitOid: string | null;
      }
    | { occurrenceId: string; checkoutPath: string; status: "merged"; oid: string; mergedCommitOid: string };

export type MergeTaskWalkReport =
    | { status: "merged"; completedLayers: MergeLayerOutcome[] }
    | {
          status: "submodule-conflicted";
          completedLayers: MergeLayerOutcome[];
          occurrenceId: string;
          checkoutPath: string;
          stage: "rebase" | "test" | "merge";
          conflictedFilePaths: string[];
          failureReason: string | null;
      }
    | {
          status: "parent-conflicted";
          completedLayers: MergeLayerOutcome[];
          checkoutPath: string;
          stage: "rebase" | "test" | "merge";
          conflictedFilePaths: string[];
          failureReason: string | null;
      }
    | {
          status: "merge-record-missing";
          completedLayers: MergeLayerOutcome[];
          occurrenceId: string;
          checkoutPath: string;
          stage: "merge";
          failureReason: string;
      }
    // The root merge already landed at mergedCommitHash; only persisting that record afterward failed (C86-21).
    | { status: "root-merged-but-not-closed"; completedLayers: MergeLayerOutcome[]; mergedCommitHash: string; failureReason: string };

// Checks out each child's merged tip for real, so `git add` records a gitlink matching the checkout.
function propagateChildGitlinks(
    occurrence: RepositoryOccurrence,
    childrenByParentId: Map<string, RepositoryOccurrence[]>,
    sourceTipByOccurrenceId: Map<string, string>,
    sourceCheckoutPathByOccurrenceId: Map<string, string>,
): void {
    let stagedAnyChange = false;
    for (const child of childrenByParentId.get(occurrence.occurrenceId) ?? []) {
        const childSourceTip = sourceTipByOccurrenceId.get(child.occurrenceId);
        const childSourceCheckoutPath = sourceCheckoutPathByOccurrenceId.get(child.occurrenceId);
        if (childSourceTip === undefined || child.pathInParent === null || childSourceCheckoutPath === undefined) continue;
        const recordedOid = git(occurrence.checkoutPath, "rev-parse", `HEAD:${child.pathInParent}`).trim();
        if (recordedOid === childSourceTip) continue;
        // Fetch to FETCH_HEAD, not straight into refs/heads/<branch>: a retry's branch may already be checked out here.
        git(child.checkoutPath, "fetch", childSourceCheckoutPath, child.baseBranch);
        git(child.checkoutPath, "checkout", "-B", child.baseBranch, "FETCH_HEAD");
        git(occurrence.checkoutPath, "add", child.pathInParent);
        stagedAnyChange = true;
    }
    if (!stagedAnyChange) return;
    git(occurrence.checkoutPath, "commit", "-m", "taskTools: point submodule gitlinks at merged source tips");
}

// Rebases, tests, and merges each occurrence deepest-first; skips occurrences already merged into their own source branch.
export function mergeTaskDeepestFirst(
    worktreePath: string,
    manifest: DiscoveryManifest,
    mergeStepOperations: MergeStepOperations = defaultMergeStepOperations,
): MergeTaskWalkReport {
    const sourceCheckoutPathByOccurrenceId = new Map(
        manifest.repositoryManifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence.checkoutPath]),
    );

    const discovery = discoverRepositoryTree(worktreePath, manifest);
    if (discovery.status === "needsResolution") {
        throw new Error(`repository tree discovery needs resolution for: ${discovery.resolutionRequests.map((request) => request.occurrenceId).join(", ")}`);
    }

    const rootOccurrence = discovery.graph.find((occurrence) => occurrence.parentOccurrenceId === null)!;
    const submoduleOccurrencesDeepestFirst = discovery.graph
        .filter((occurrence) => occurrence.parentOccurrenceId !== null)
        .sort((a, b) => b.depth - a.depth);
    const orderedOccurrences = [...submoduleOccurrencesDeepestFirst, rootOccurrence];
    const childrenByParentId = groupChildrenByParentId(discovery.graph);

    // Fetch each task branch first and mark occurrences already merged into source; those skip rebase, test, and merge.
    const skippedOccurrenceIds = new Set<string>();
    for (const occurrence of orderedOccurrences) {
        const sourceCheckoutPath = sourceCheckoutPathByOccurrenceId.get(occurrence.occurrenceId)!;
        if (occurrence.parentOccurrenceId !== null) {
            git(sourceCheckoutPath, "fetch", occurrence.checkoutPath, `${occurrence.operationBranch}:refs/heads/${occurrence.operationBranch}`);
        }
        if (unmergedCommitCount(sourceCheckoutPath, occurrence.baseBranch, occurrence.operationBranch) === 0) {
            skippedOccurrenceIds.add(occurrence.occurrenceId);
        }
    }

    const completedLayers: MergeLayerOutcome[] = [];
    // Every completed occurrence's source tip, so its container can record that OID rather than the child's pre-merge tip.
    const sourceTipByOccurrenceId = new Map<string, string>();
    for (const occurrence of orderedOccurrences) {
        const sourceCheckoutPath = sourceCheckoutPathByOccurrenceId.get(occurrence.occurrenceId)!;
        const displayId = displayOccurrenceId(occurrence.occurrenceId);

        if (skippedOccurrenceIds.has(occurrence.occurrenceId)) {
            const currentSourceOid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            const mergedCommitOid = readOptionalRef(sourceCheckoutPath, mergedCommitRefName(occurrence.operationBranch));
            const pendingIntent = readOptionalRef(sourceCheckoutPath, mergeIntentRefName(occurrence.operationBranch));

            // A surviving intent means the prior process may have died mid-merge; refuse to guess.
            if (pendingIntent !== null || (occurrence.parentOccurrenceId === null && mergedCommitOid === null)) {
                return {
                    status: "merge-record-missing",
                    completedLayers,
                    occurrenceId: displayId,
                    checkoutPath: occurrence.checkoutPath,
                    stage: "merge",
                    failureReason:
                        `task branch "${occurrence.operationBranch}" is already merged in `
                        + `occurrence "${displayId}", but its merge-time commit record is missing; `
                        + `refusing to guess from the current ${occurrence.baseBranch} tip`,
                };
            }

            // Propagate the current child source tip, not this task's older merge commit.
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, currentSourceOid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "no-op", oid: currentSourceOid, mergedCommitOid });
            // C86-10: retain the fetched source-submodule task ref until the whole task closes.
            continue;
        }

        try {
            propagateChildGitlinks(occurrence, childrenByParentId, sourceTipByOccurrenceId, sourceCheckoutPathByOccurrenceId);

            if (occurrence.parentOccurrenceId !== null) {
                const rebaseOutcome = rebaseAndTestSubmoduleLayer(occurrence, sourceCheckoutPath, manifest.resolutionManifest, childrenByParentId);
                if (rebaseOutcome.status === "conflicted") {
                    return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "rebase", conflictedFilePaths: rebaseOutcome.conflictedFilePaths, failureReason: null };
                }
                if (rebaseOutcome.status === "cleanup-failed" || rebaseOutcome.status === "source-sync-failed") {
                    return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "rebase", conflictedFilePaths: [], failureReason: rebaseOutcome.failureReason };
                }
                if (rebaseOutcome.status === "tests-failed") {
                    return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "test", conflictedFilePaths: [], failureReason: rebaseOutcome.testOutput };
                }
                if (rebaseOutcome.status === "untested") {
                    return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "test", conflictedFilePaths: [], failureReason: "test policy needs resolution" };
                }

                // A gitlink-bump commit since the initial fetch may not be in sourceCheckoutPath yet.
                git(sourceCheckoutPath, "fetch", occurrence.checkoutPath, `${occurrence.operationBranch}:refs/heads/${occurrence.operationBranch}`);
                const operationOid = git(occurrence.checkoutPath, "rev-parse", occurrence.operationBranch).trim();
                recordMergeIntent(sourceCheckoutPath, occurrence.operationBranch, operationOid);

                const result = mergeStepOperations.mergeSubmodule(sourceCheckoutPath, occurrence.checkoutPath, occurrence.baseBranch);
                if (!result.merged) {
                    clearMergeIntent(sourceCheckoutPath, occurrence.operationBranch);
                    return { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "merge", conflictedFilePaths: result.conflictedFilePaths, failureReason: result.failureReason };
                }
                // Do not delete occurrence.operationBranch here: parent merge and close can still fail.
                const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
                // The merge already landed: record progress before the record write, which is best-effort (C86-42).
                sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
                completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "merged", oid, mergedCommitOid: oid });
                try {
                    recordMergedCommit(sourceCheckoutPath, occurrence.operationBranch, oid);
                } catch {
                    // Landed layer already tracked above; retry takes the no-op skip path instead of guessing.
                }
                clearMergeIntentBestEffort(sourceCheckoutPath, occurrence.operationBranch);
                continue;
            }

            const directChildPathsInParent = (childrenByParentId.get(occurrence.occurrenceId) ?? [])
                .map((child) => child.pathInParent)
                .filter((pathInParent): pathInParent is string => pathInParent !== null);

            const parentOutcome = rebaseParentOntoSourceAndTest(occurrence.occurrenceId, occurrence.checkoutPath, occurrence.baseBranch, directChildPathsInParent, manifest.resolutionManifest);
            if (parentOutcome.status === "conflicted") {
                return { status: "parent-conflicted", completedLayers, checkoutPath: occurrence.checkoutPath, stage: "rebase", conflictedFilePaths: parentOutcome.conflictedFilePaths, failureReason: null };
            }
            if (parentOutcome.status === "cleanup-failed") {
                return { status: "parent-conflicted", completedLayers, checkoutPath: occurrence.checkoutPath, stage: "rebase", conflictedFilePaths: [], failureReason: parentOutcome.failureReason };
            }
            if (parentOutcome.status === "tests-failed") {
                return { status: "parent-conflicted", completedLayers, checkoutPath: occurrence.checkoutPath, stage: "test", conflictedFilePaths: [], failureReason: parentOutcome.testOutput };
            }
            if (parentOutcome.status === "untested") {
                return { status: "parent-conflicted", completedLayers, checkoutPath: occurrence.checkoutPath, stage: "test", conflictedFilePaths: [], failureReason: "test policy needs resolution" };
            }

            const group: PreparedGroup = { groupId: 0, worktree: occurrence.checkoutPath, branch: occurrence.operationBranch, scope: "unknown", tasks: [] };
            const operationOid = git(occurrence.checkoutPath, "rev-parse", occurrence.operationBranch).trim();
            recordMergeIntent(sourceCheckoutPath, occurrence.operationBranch, operationOid);

            const result = mergeStepOperations.mergeGroup(sourceCheckoutPath, group, occurrence.baseBranch, directChildPathsInParent);
            if (!result.merged) {
                clearMergeIntent(sourceCheckoutPath, occurrence.operationBranch);
                return { status: "parent-conflicted", completedLayers, checkoutPath: occurrence.checkoutPath, stage: "merge", conflictedFilePaths: result.conflictedFilePaths, failureReason: result.failureReason };
            }
            // The root merge already landed at this OID: a failure from here on is merged-but-not-closed, never an ordinary conflict.
            const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
            try {
                recordMergedCommit(sourceCheckoutPath, occurrence.operationBranch, oid);
            } catch (error) {
                return { status: "root-merged-but-not-closed", completedLayers, mergedCommitHash: oid, failureReason: gitErrorText(error) };
            }
            sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
            completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "merged", oid, mergedCommitOid: oid });
            clearMergeIntentBestEffort(sourceCheckoutPath, occurrence.operationBranch);
        } catch (error) {
            // An unexpected operational failure (e.g. a rejected commit hook) must not discard already-completed layers.
            return occurrence.parentOccurrenceId !== null
                ? { status: "submodule-conflicted", completedLayers, occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, stage: "merge", conflictedFilePaths: [], failureReason: gitErrorText(error) }
                : { status: "parent-conflicted", completedLayers, checkoutPath: occurrence.checkoutPath, stage: "merge", conflictedFilePaths: [], failureReason: gitErrorText(error) };
        }
    }

    return { status: "merged", completedLayers };
}

function runDiscoverCli(): void {
    const repoRoot = process.cwd();
    const sourceBranch = currentBranchName(repoRoot);
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const results = findUnmergedTaskWorktrees(repoRoot, sourceBranch, openTasks);
    process.stdout.write(JSON.stringify(results));
}

function runMergeCli(worktreePath: string): void {
    const repoRoot = process.cwd();
    const repositorySources = collectRepositorySources(repoRoot);
    const parentSource = repositorySources.find((source) => source.path === "");
    if (!parentSource) throw new Error(`no recorded source branch for repository path "${repoRoot}"`);
    const submodulePathsDeepestFirst = repositorySources
        .map((source) => source.path)
        .filter((path) => path !== "")
        .sort((a, b) => b.split("/").length - a.split("/").length);
    const branch = currentBranchName(worktreePath);
    const group: PreparedGroup = { groupId: 0, worktree: worktreePath, branch, scope: "unknown", tasks: [] };
    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, parentSource.sourceBranch, submodulePathsDeepestFirst);
    if (outcome.merged) removeWorktreeAndBranch(repoRoot, worktreePath, branch);
    process.stdout.write(JSON.stringify(outcome));
}

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
