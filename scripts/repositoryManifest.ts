// Versioned repository occurrence graph: one RepositoryOccurrence per checked-out repository location.
import { readFileSync, writeFileSync } from "node:fs";

export const REPOSITORY_MANIFEST_VERSION = 1;

export type TestState = "untested" | "passed" | "failed";

export type RepositoryOccurrence = {
    occurrenceId: string;
    checkoutPath: string;
    parentOccurrenceId: string | null;
    pathInParent: string | null;
    gitlinkOid: string | null;
    depth: number;
    originUrl: string;
    baseBranch: string;
    baseOid: string;
    operationBranch: string;
    childOccurrenceIds: string[];
    testState: TestState;
};

export type RepositoryManifest = {
    version: number;
    occurrences: RepositoryOccurrence[];
};

export function readRepositoryManifest(path: string): RepositoryManifest {
    return JSON.parse(readFileSync(path, "utf8"));
}

export function writeRepositoryManifest(path: string, manifest: RepositoryManifest): void {
    writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

export type ManifestValidationResult = { valid: boolean; errors: string[] };

// Walks parentOccurrenceId edges from `occurrence` to a root, counting hops.
function depthFromParentChain(
    occurrence: RepositoryOccurrence,
    occurrenceById: Map<string, RepositoryOccurrence>,
): number | null {
    const visited = new Set<string>();
    let current = occurrence;
    let depth = 0;
    while (current.parentOccurrenceId !== null) {
        if (visited.has(current.occurrenceId)) return null;
        visited.add(current.occurrenceId);
        const parent = occurrenceById.get(current.parentOccurrenceId);
        if (!parent) return null;
        depth += 1;
        current = parent;
    }
    return depth;
}

export function validateRepositoryManifest(manifest: RepositoryManifest): ManifestValidationResult {
    const errors: string[] = [];
    const occurrenceById = new Map<string, RepositoryOccurrence>();
    const duplicateIds = new Set<string>();
    for (const occurrence of manifest.occurrences) {
        if (occurrenceById.has(occurrence.occurrenceId)) duplicateIds.add(occurrence.occurrenceId);
        occurrenceById.set(occurrence.occurrenceId, occurrence);
    }
    for (const duplicateId of duplicateIds) {
        errors.push(`duplicate occurrence ID: "${duplicateId}"`);
    }

    for (const occurrence of manifest.occurrences) {
        if (occurrence.parentOccurrenceId === null) continue;
        if (!occurrenceById.has(occurrence.parentOccurrenceId)) {
            errors.push(
                `occurrence "${occurrence.occurrenceId}" has a dangling parent occurrence ID "${occurrence.parentOccurrenceId}"`,
            );
        }
    }

    for (const occurrence of manifest.occurrences) {
        const expectedDepth = depthFromParentChain(occurrence, occurrenceById);
        if (expectedDepth !== null && occurrence.depth !== expectedDepth) {
            errors.push(
                `occurrence "${occurrence.occurrenceId}" has depth ${occurrence.depth}, expected ${expectedDepth} from its parent chain`,
            );
        }
    }

    return { valid: errors.length === 0, errors };
}
