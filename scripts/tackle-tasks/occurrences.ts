// Walks a worktree's occurrence tree deepest submodule first, root last (pipeline.mmd rule 8),
// and bridges the two path namespaces: plain task-declared paths and occurrence-tagged changed paths.
import { execFileSync } from "node:child_process";
import { REPOSITORY_MANIFEST_VERSION } from "../repositoryManifest.ts";
import { discoverRepositoryTree } from "../repositoryDiscovery.ts";
import type { DiscoveryManifest } from "../repositoryDiscovery.ts";
import { createEmptyResolutionManifest } from "../resolutionRequests.ts";

export type Occurrence = {
    occurrenceId: string;
    checkoutPath: string;
    depth: number;
    baseRef: string;
};

const OCCURRENCE_PATH_SEPARATOR = "::";

// projectRoot is accepted for signature parity with the rest of the pipeline's (worktreePath,
// projectRoot) boxes; discovery itself only ever needs the worktree's own git state.
export function buildDiscoveryManifest(worktreePath: string, projectRoot: string): DiscoveryManifest {
    void projectRoot;
    const manifest: DiscoveryManifest = {
        repositoryManifest: { version: REPOSITORY_MANIFEST_VERSION, occurrences: [] },
        resolutionManifest: createEmptyResolutionManifest(),
    };
    discoverRepositoryTree(worktreePath, manifest);
    return manifest;
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
            baseRef: occurrence.occurrenceId === ""
                ? rootSourceBranch
                : occurrence.baseBranch || resolveRecordedUpstreamBranch(occurrence.checkoutPath),
        }));
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
