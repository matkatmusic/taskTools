// Pure traversal helpers over the occurrence graph recorded by repositoryManifest.ts.
import { relative } from "node:path";
import type { RepositoryManifest, RepositoryOccurrence } from "./repositoryManifest.ts";

function rootCandidates(manifest: RepositoryManifest): RepositoryOccurrence[] {
    return manifest.occurrences.filter((occurrence) => occurrence.parentOccurrenceId === null);
}

// Raw-matching root -> already-relative checkout convention. No match with one root -> absolute production root, relativize.
function selectRoot(
    rootRelativePath: string,
    manifest: RepositoryManifest,
): { root: RepositoryOccurrence; relativize: boolean } | null {
    const candidates = rootCandidates(manifest);
    const rawMatch = candidates.find((root) => isWithinCheckout(rootRelativePath, root.checkoutPath));
    if (rawMatch) return { root: rawMatch, relativize: false };
    if (candidates.length === 1) return { root: candidates[0], relativize: true };
    return null;
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
    const selected = selectRoot(rootRelativePath, manifest);
    if (!selected) return null;
    const { root, relativize } = selected;

    let owner = root;
    let descended = true;
    while (descended) {
        descended = false;
        for (const child of getChildren(owner, manifest)) {
            const childCheckoutPath = relativize ? checkoutPathFromRoot(child, root) : child.checkoutPath;
            if (isWithinCheckout(rootRelativePath, childCheckoutPath)) {
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
    manifest: RepositoryManifest,
): string {
    const ancestors = getAncestorChain(owningOccurrence, manifest);
    const root = ancestors.length > 0 ? ancestors[ancestors.length - 1] : owningOccurrence;
    const relativize = !isWithinCheckout(rootRelativePath, root.checkoutPath);
    const checkoutPath = relativize ? checkoutPathFromRoot(owningOccurrence, root) : owningOccurrence.checkoutPath;
    if (checkoutPath === "") return rootRelativePath;
    if (rootRelativePath === checkoutPath) return "";
    return rootRelativePath.slice(checkoutPath.length + 1);
}
