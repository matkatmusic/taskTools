// Pure traversal helpers over the occurrence graph recorded by repositoryManifest.ts.
import { relative } from "node:path";
import type { RepositoryManifest, RepositoryOccurrence } from "./repositoryManifest.ts";

function findRootOccurrence(manifest: RepositoryManifest): RepositoryOccurrence | null {
    return manifest.occurrences.find((occurrence) => occurrence.parentOccurrenceId === null) ?? null;
}

// Discovery records checkoutPath absolutely; task paths are root-relative. relative() collapses both.
function checkoutPathFromRoot(occurrence: RepositoryOccurrence, root: RepositoryOccurrence): string {
    return relative(root.checkoutPath, occurrence.checkoutPath);
}

function buildOccurrenceIndex(manifest: RepositoryManifest): Map<string, RepositoryOccurrence> {
    return new Map(manifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
}

export function getChildren(
    occurrence: RepositoryOccurrence,
    manifest: RepositoryManifest,
): RepositoryOccurrence[] {
    const index = buildOccurrenceIndex(manifest);
    return occurrence.childOccurrenceIds.map((childId) => {
        const child = index.get(childId);
        if (!child) throw new Error(`missing occurrence for child ID "${childId}"`);
        return child;
    });
}

// Walks recorded parentOccurrenceId edges up to the root; excludes the occurrence itself.
export function getAncestorChain(
    occurrence: RepositoryOccurrence,
    manifest: RepositoryManifest,
): RepositoryOccurrence[] {
    const index = buildOccurrenceIndex(manifest);
    const chain: RepositoryOccurrence[] = [];
    let current = occurrence;
    while (current.parentOccurrenceId !== null) {
        const parent = index.get(current.parentOccurrenceId);
        if (!parent) break;
        chain.push(parent);
        current = parent;
    }
    return chain;
}

export function getDeepestFirstOrder(occurrences: RepositoryOccurrence[]): RepositoryOccurrence[] {
    return [...occurrences].sort((a, b) => {
        if (a.depth !== b.depth) return b.depth - a.depth;
        return (a.pathInParent ?? "").localeCompare(b.pathInParent ?? "");
    });
}

function isWithinCheckout(rootRelativePath: string, checkoutPath: string): boolean {
    if (checkoutPath === "") return true;
    return rootRelativePath === checkoutPath || rootRelativePath.startsWith(`${checkoutPath}/`);
}

// Descends recorded child edges, matching only recorded checkoutPath -- never splits the input path.
export function getOwningOccurrence(
    rootRelativePath: string,
    manifest: RepositoryManifest,
): RepositoryOccurrence | null {
    let owner =
        manifest.occurrences.find(
            (occurrence) =>
                occurrence.parentOccurrenceId === null &&
                isWithinCheckout(rootRelativePath, occurrence.checkoutPath),
        ) ?? null;
    if (!owner) return null;

    let descended = true;
    while (descended) {
        descended = false;
        for (const child of getChildren(owner, manifest)) {
            if (isWithinCheckout(rootRelativePath, child.checkoutPath)) {
                owner = child;
                descended = true;
                break;
            }
        }
    }
    return owner;
}

export function getPathWithinRepository(
    rootRelativePath: string,
    owningOccurrence: RepositoryOccurrence,
): string {
    const { checkoutPath } = owningOccurrence;
    if (checkoutPath === "") return rootRelativePath;
    if (rootRelativePath === checkoutPath) return "";
    return rootRelativePath.slice(checkoutPath.length + 1);
}
