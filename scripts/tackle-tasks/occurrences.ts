// Walks a worktree's occurrence tree deepest submodule first, root last (pipeline.mmd rule 8),
// and bridges the two path namespaces: plain task-declared paths and occurrence-tagged changed paths.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { attachOperationBranch, loadRepositoryManifest } from "../prepareTasks.ts";
import type { DiscoveryManifest } from "../repositoryDiscovery.ts";
import type { RepositoryOccurrence } from "../repositoryManifest.ts";
import { createEmptyResolutionManifest } from "../resolutionRequests.ts";
import {
    defaultMergeStepOperations,
    mergeTaskDeepestFirst,
    rebaseSubmoduleLayersDeepestFirst,
    type MergeStepOperations,
    type MergeTaskWalkReport,
    type SubmoduleLayerWalkReport,
} from "../mergeTaskWorktrees.ts";

export type Occurrence = {
    occurrenceId: string;
    checkoutPath: string;
    depth: number;
    baseRef: string;
};

// F1: the source repository's checkout (the local, possibly-unpushed, lock-held authority) and
// the task worktree's checkout are never the same directory, even though both are addressed by
// the same occurrenceId. Any code that reads/fetches "the source" or "the worktree" for a given
// occurrence should build this once and read the matching field, rather than re-deriving either
// path independently.
export type WorktreeOccurrence = {
    occurrenceId: string;
    sourceCheckoutPath: string;
    worktreeCheckoutPath: string;
    depth: number;
    baseBranch: string;
};

// The one source<->worktree mapping every v1.5 consumer should share: matches the live source
// manifest's occurrences to their worktree checkout by occurrenceId. Call this (or one of the
// wrappers below that reuse it) only after the source lock is held/refreshed, so the source
// occurrences it reads reflect the checkout the lock protects.
export function mapSourceOccurrencesToWorktree(
    worktreePath: string,
    sourceOccurrences: RepositoryOccurrence[],
): WorktreeOccurrence[] {
    return sourceOccurrences.map((occurrence) => ({
        occurrenceId: occurrence.occurrenceId,
        sourceCheckoutPath: occurrence.checkoutPath,
        worktreeCheckoutPath: occurrence.occurrenceId === "" ? worktreePath : join(worktreePath, occurrence.occurrenceId),
        depth: occurrence.depth,
        baseBranch: occurrence.baseBranch,
    }));
}

export function buildWorktreeOccurrences(worktreePath: string, projectRoot: string): WorktreeOccurrence[] {
    return mapSourceOccurrencesToWorktree(worktreePath, loadRepositoryManifest(projectRoot).occurrences);
}

// Fetches every non-root occurrence's base branch from its real source checkout into its
// worktree checkout (never origin: the locked local source checkout is the target-branch
// authority and its commits may not be pushed). This must run before any discovery/rebase code
// inspects an occurrence's source-recorded OID inside the worktree - discovery walks a
// submodule's tree by ls-tree'ing that OID directly in the worktree checkout, which fails with
// "fatal: not a tree object" if the source has advanced past what the worktree has fetched.
export function fetchWorktreeBaseBranchesFromSource(occurrences: WorktreeOccurrence[]): void {
    for (const occurrence of occurrences) {
        if (occurrence.occurrenceId === "") continue;
        execFileSync(
            "git",
            // --no-recurse-submodules: nested occurrences are fetched independently by their own
            // entry in this same loop, from their own source checkout - git's on-demand recursive
            // fetch would otherwise try (and fail) to pull an unpushed nested advance from the
            // worktree submodule's unrelated "origin" remote.
            ["-C", occurrence.worktreeCheckoutPath, "fetch", "--no-recurse-submodules", occurrence.sourceCheckoutPath, occurrence.baseBranch],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
    }
}

const OCCURRENCE_PATH_SEPARATOR = "::";

// The source repository, never the task worktree, is the authority for each layer's base
// branch: createWorktreeForGroup checks out task-N in every submodule, so discovering the
// worktree itself would make every layer's own branch invisible.
export function buildDiscoveryManifest(worktreePath: string, projectRoot: string): DiscoveryManifest {
    const sourceManifest = loadRepositoryManifest(projectRoot);
    return {
        repositoryManifest: {
            ...sourceManifest,
            occurrences: sourceManifest.occurrences.map((occurrence) => ({
                ...occurrence,
                checkoutPath: occurrence.occurrenceId === ""
                    ? worktreePath
                    : join(worktreePath, occurrence.occurrenceId),
            })),
        },
        resolutionManifest: createEmptyResolutionManifest(),
    };
}

function resolveRecordedUpstreamBranch(checkoutPath: string): string {
    try {
        return execFileSync("git", ["-C", checkoutPath, "rev-parse", "--abbrev-ref", "@{upstream}"], {
            encoding: "utf8",
        }).trim();
    } catch {
        return "";
    }
}

export function getOccurrencesDeepestFirst(
    worktreePath: string,
    projectRoot: string,
    rootSourceBranch: string,
): Occurrence[] {
    const manifest = buildDiscoveryManifest(worktreePath, projectRoot);
    return manifest.repositoryManifest.occurrences
        .slice()
        .sort((a, b) => b.depth - a.depth)
        .map((occurrence) => ({
            occurrenceId: occurrence.occurrenceId,
            checkoutPath: occurrence.checkoutPath,
            depth: occurrence.depth,
            baseRef: resolveOccurrenceBaseRef(occurrence, rootSourceBranch),
        }));
}

export function resolveOccurrenceBaseRef(
    occurrence: RepositoryOccurrence,
    rootSourceBranch: string,
): string {
    if (occurrence.occurrenceId === "") return rootSourceBranch;
    const baseRef = occurrence.baseBranch || resolveRecordedUpstreamBranch(occurrence.checkoutPath);
    if (baseRef === "") {
        throw new Error(`occurrence "${occurrence.occurrenceId}" has no resolvable base ref`);
    }
    return baseRef;
}

export function buildOccurrencePath(occurrenceId: string, relativePath: string): string {
    if (occurrenceId === "") return relativePath;
    return `${occurrenceId}${OCCURRENCE_PATH_SEPARATOR}${relativePath}`;
}

export function parseOccurrencePath(occurrencePath: string): { occurrenceId: string; relativePath: string } {
    const separatorIndex = occurrencePath.indexOf(OCCURRENCE_PATH_SEPARATOR);
    if (separatorIndex === -1) return { occurrenceId: "", relativePath: occurrencePath };
    return {
        occurrenceId: occurrencePath.slice(0, separatorIndex),
        relativePath: occurrencePath.slice(separatorIndex + OCCURRENCE_PATH_SEPARATOR.length),
    };
}

// Builds the SOURCE-checkoutPath manifest that mergeTaskWorktrees.ts's deepest-first walkers
// require: they snapshot manifest.repositoryManifest.occurrences[*].checkoutPath as the source
// side of every fetch before running discovery, so this must never be worktree-remapped like
// buildDiscoveryManifest's occurrences are.
function buildSourceDiscoveryManifest(sourceManifest: ReturnType<typeof loadRepositoryManifest>, taskNumber: number): DiscoveryManifest {
    return {
        repositoryManifest: {
            ...sourceManifest,
            occurrences: attachOperationBranch(sourceManifest.occurrences, `task-${taskNumber}`),
        },
        resolutionManifest: createEmptyResolutionManifest(),
    };
}

// F1-safe replacement for "buildDiscoveryManifest(worktreePath, projectRoot) then
// rebaseSubmoduleLayersDeepestFirst": pre-fetches every occurrence's base branch from its real
// source checkout into its worktree checkout, then rebases with a manifest that keeps the real
// source checkoutPath. Call after the source lock is held/refreshed.
export function rebaseWorktreeSubmoduleLayersDeepestFirst(
    worktreePath: string,
    projectRoot: string,
    taskNumber: number,
    leaveConflictLive: boolean = false,
    typecheckCommand: string | null = null,
): SubmoduleLayerWalkReport {
    const sourceManifest = loadRepositoryManifest(projectRoot);
    fetchWorktreeBaseBranchesFromSource(mapSourceOccurrencesToWorktree(worktreePath, sourceManifest.occurrences));
    const manifest = buildSourceDiscoveryManifest(sourceManifest, taskNumber);
    return rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, leaveConflictLive, typecheckCommand);
}

// F1-safe replacement for building a source-checkoutPath manifest by hand and calling
// mergeTaskDeepestFirst (see mergeTaskWorktree.ts's prior inline version of this). Same
// pre-fetch guarantee as the rebase wrapper above; call after the source lock is
// held/refreshed.
export function mergeWorktreeTaskDeepestFirst(
    worktreePath: string,
    projectRoot: string,
    taskNumber: number,
    mergeStepOperations: MergeStepOperations = defaultMergeStepOperations,
    typecheckCommand: string | null = null,
): MergeTaskWalkReport {
    const sourceManifest = loadRepositoryManifest(projectRoot);
    fetchWorktreeBaseBranchesFromSource(mapSourceOccurrencesToWorktree(worktreePath, sourceManifest.occurrences));
    const manifest = buildSourceDiscoveryManifest(sourceManifest, taskNumber);
    return mergeTaskDeepestFirst(worktreePath, manifest, mergeStepOperations, typecheckCommand);
}

export function buildOwnedOccurrencePaths(taskFiles: string[], occurrences: Occurrence[]): string[] {
    const nonRootOccurrenceIdsLongestFirst = occurrences
        .map((occurrence) => occurrence.occurrenceId)
        .filter((occurrenceId) => occurrenceId !== "")
        .sort((a, b) => b.length - a.length);

    return taskFiles.map((taskFile) => {
        const owningOccurrenceId = nonRootOccurrenceIdsLongestFirst.find((occurrenceId) =>
            taskFile.startsWith(`${occurrenceId}/`),
        );
        if (owningOccurrenceId === undefined) return buildOccurrencePath("", taskFile);
        return buildOccurrencePath(owningOccurrenceId, taskFile.slice(owningOccurrenceId.length + 1));
    });
}
