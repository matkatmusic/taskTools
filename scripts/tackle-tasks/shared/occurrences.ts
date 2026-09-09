// Walks a worktree's occurrence tree deepest-submodule-first, root last (rule 8), bridging task-declared and occurrence-tagged paths.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { attachOperationBranch, loadRepositoryManifest } from "../../shared/prepareTasks.ts";
import type { DiscoveryManifest } from "../../shared/repositoryDiscovery.ts";
import type { RepositoryManifest, RepositoryOccurrence } from "../../shared/repositoryManifest.ts";
import { createEmptyResolutionManifest } from "../../shared/resolutionRequests.ts";
import { ensureStagingWorktree, stagingWorktreePath } from "./stagingWorktree.ts";
import {
    defaultMergeStepOperations,
    mergeTaskDeepestFirst,
    rebaseSubmoduleLayersDeepestFirst,
    type MergeStepOperations,
    type MergeTaskWalkReport,
    type SubmoduleLayerWalkReport,
} from "../../merge-worktree-tasks/mergeTaskWorktrees.ts";

export type Occurrence = {
    occurrenceId: string;
    checkoutPath: string;
    depth: number;
    baseRef: string;
};

// F1: source and worktree checkouts differ despite sharing an occurrenceId; build this once and reuse it, don't re-derive paths.
export type WorktreeOccurrence = {
    occurrenceId: string;
    sourceCheckoutPath: string;
    worktreeCheckoutPath: string;
    depth: number;
    baseBranch: string;
};

// The shared v1.5 source<->worktree mapping matches source occurrences to worktree checkouts; call only after the source lock is held.
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

export function buildWorktreeOccurrences(worktreePath: string, projectRoot: string, rootSourceBranch: string): WorktreeOccurrence[] {
    return mapSourceOccurrencesToWorktree(worktreePath, loadSourceManifest(projectRoot, rootSourceBranch).occurrences);
}

// Every source checkoutPath now lives under the staging worktree; refs are shared, so nothing else moves.
export function loadSourceManifest(projectRoot: string, rootSourceBranch: string): RepositoryManifest {
    ensureStagingWorktree(projectRoot, rootSourceBranch);
    return loadRepositoryManifest(stagingWorktreePath(projectRoot), rootSourceBranch);
}

// Fetches each occurrence's base branch from source into worktree, never origin; run before discovery walks source-recorded OIDs.
export function fetchWorktreeBaseBranchesFromSource(occurrences: WorktreeOccurrence[]): void {
    for (const occurrence of occurrences) {
        if (occurrence.occurrenceId === "") continue;
        execFileSync(
            "git",
            // --no-recurse-submodules: nested occurrences fetch independently via their own loop entry; recursive fetch would otherwise fail from wrong origin.
            ["-C", occurrence.worktreeCheckoutPath, "fetch", "--no-recurse-submodules", occurrence.sourceCheckoutPath, occurrence.baseBranch],
            { stdio: ["ignore", "pipe", "pipe"] },
        );
    }
}

const OCCURRENCE_PATH_SEPARATOR = "::";

// The source repository, not the worktree, is the base-branch authority; createWorktreeForGroup checks out task-N everywhere, hiding layer branches.
export function buildDiscoveryManifest(worktreePath: string, projectRoot: string, rootSourceBranch: string): DiscoveryManifest {
    const sourceManifest = loadSourceManifest(projectRoot, rootSourceBranch);
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
    const manifest = buildDiscoveryManifest(worktreePath, projectRoot, rootSourceBranch);
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

// Builds the SOURCE-checkoutPath manifest mergeTaskWorktrees.ts's walkers require; unlike buildDiscoveryManifest, this must never be worktree-remapped.
function buildSourceDiscoveryManifest(
    sourceManifest: ReturnType<typeof loadRepositoryManifest>,
    taskNumber: number,
    rootSourceBranch: string,
): DiscoveryManifest {
    return {
        repositoryManifest: {
            ...sourceManifest,
            // Every repo (root and every nested submodule) always merges/rebases against rootSourceBranch ("staging"), never each occurrence's manifest-recorded baseBranch (e.g. "Layer3-9").
            occurrences: attachOperationBranch(sourceManifest.occurrences, `task-${taskNumber}`)
                .map((occurrence) => ({ ...occurrence, baseBranch: rootSourceBranch })),
        },
        resolutionManifest: createEmptyResolutionManifest(),
    };
}

// F1-safe replacement for buildDiscoveryManifest-then-rebase; pre-fetches occurrences, then rebases with a source-checkoutPath manifest; call after the source lock is held.
export function rebaseWorktreeSubmoduleLayersDeepestFirst(
    worktreePath: string,
    projectRoot: string,
    taskNumber: number,
    rootSourceBranch: string,
    leaveConflictLive: boolean = false,
    typecheckCommand: string | null = null,
    runTests: boolean = true,
): SubmoduleLayerWalkReport {
    const sourceManifest = loadSourceManifest(projectRoot, rootSourceBranch);
    fetchWorktreeBaseBranchesFromSource(mapSourceOccurrencesToWorktree(worktreePath, sourceManifest.occurrences));
    const manifest = buildSourceDiscoveryManifest(sourceManifest, taskNumber, rootSourceBranch);
    return rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, leaveConflictLive, typecheckCommand, runTests);
}

// F1-safe replacement for hand-building a source-checkoutPath manifest and calling mergeTaskDeepestFirst; same pre-fetch guarantee, call after source lock is held.
export function mergeWorktreeTaskDeepestFirst(
    worktreePath: string,
    projectRoot: string,
    taskNumber: number,
    rootSourceBranch: string,
    mergeStepOperations: MergeStepOperations = defaultMergeStepOperations,
    typecheckCommand: string | null = null,
    runTests: boolean = true,
): MergeTaskWalkReport {
    const sourceManifest = loadSourceManifest(projectRoot, rootSourceBranch);
    fetchWorktreeBaseBranchesFromSource(mapSourceOccurrencesToWorktree(worktreePath, sourceManifest.occurrences));
    // (retired: root-only baseBranch remap; buildSourceDiscoveryManifest now forces every occurrence uniformly)
    // const occurrencesWithRootSourceBranch = sourceManifest.occurrences.map((occurrence) =>
    //     occurrence.occurrenceId === "" ? { ...occurrence, baseBranch: rootSourceBranch } : occurrence,
    // );
    const manifest = buildSourceDiscoveryManifest(sourceManifest, taskNumber, rootSourceBranch);
    return mergeTaskDeepestFirst(worktreePath, manifest, mergeStepOperations, typecheckCommand, runTests);
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
