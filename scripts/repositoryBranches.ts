// Reads/creates the branch each repository (parent + submodules) should merge back onto.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { bootstrapRepositoryManifest } from "./manifestBootstrap.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";

export type RepositorySource = {
    path: string; // "" for the parent repo, else the submodule displaypath
    sourceBranch: string;
};

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

export function currentBranchName(repoRoot: string): string {
    return git(repoRoot, "branch", "--show-current");
}

function loadOccurrenceGraph(repoRoot: string): RepositoryOccurrence[] {
    const result = bootstrapRepositoryManifest(repoRoot);
    if (result.refused) {
        throw new Error(`repository at "${repoRoot}" needs branch resolution before it can be discovered`);
    }
    return result.occurrenceGraph;
}

export function submodulePaths(repoRoot: string): string[] {
    return loadOccurrenceGraph(repoRoot)
        .filter((occurrence) => occurrence.parentOccurrenceId !== null)
        .map((occurrence) => occurrence.occurrenceId);
}

export function collectRepositorySources(repoRoot: string): RepositorySource[] {
    let occurrences: RepositoryOccurrence[];
    try {
        occurrences = loadOccurrenceGraph(repoRoot);
    } catch (error) {
        // ponytail: a detached root throws here (not via needsResolution); reuse the guard's message.
        if (currentBranchName(repoRoot) === "") {
            throw new Error("these repositories are on a detached HEAD and cannot be task-branched: (parent)");
        }
        throw error;
    }
    const occurrenceById = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
    const paths = [
        "",
        ...occurrences.filter((occurrence) => occurrence.parentOccurrenceId !== null).map((occurrence) => occurrence.occurrenceId),
    ];

    const detachedPaths: string[] = [];
    const branchByPath = new Map<string, string>();
    for (const path of paths) {
        const fullPath = path === "" ? repoRoot : join(repoRoot, path);
        const branch = currentBranchName(fullPath);
        if (branch === "") {
            detachedPaths.push(path === "" ? "(parent)" : path);
            continue;
        }
        branchByPath.set(path, branch);
    }
    if (detachedPaths.length > 0) {
        throw new Error(
            `these repositories are on a detached HEAD and cannot be task-branched: ${detachedPaths.join(", ")}`,
        );
    }

    return paths.map((path) => ({
        path,
        sourceBranch: path === "" ? branchByPath.get(path)! : occurrenceById.get(path)!.baseBranch,
    }));
}

// -B, not -b: a branch left behind by an earlier run must be reset onto HEAD, never reused as-is.
export function createBranchInEveryRepository(repoRoot: string, paths: string[], branchName: string): void {
    for (const path of paths) {
        git(path === "" ? repoRoot : join(repoRoot, path), "checkout", "-B", branchName);
    }
}
