// Canonicalizes a task path to an ownership key, then expands it to every occurrence path plus ancestor gitlinks.
import type { RepositoryManifest } from "./repositoryManifest.ts";
import { getAncestorChain, getOwningOccurrence, getPathWithinRepository } from "./repositoryGraph.ts";
import { buildLogicalRepositories } from "./logicalRepository.ts";
import type { LogicalRepository } from "./logicalRepository.ts";

export interface OwnershipKey {
    canonicalOccurrenceId: string;
    pathWithinRepo: string;
}

export interface OwnershipEffects {
    key: OwnershipKey;
    occurrencePaths: string[];
    ancestorGitlinks: string[];
}

function findLogicalRepository(occurrenceId: string, manifest: RepositoryManifest): LogicalRepository {
    const logicalRepositories = buildLogicalRepositories(manifest.occurrences);
    const found = logicalRepositories.find((repo) => repo.occurrenceIds.includes(occurrenceId));
    if (!found) throw new Error(`no logical repository found for occurrence "${occurrenceId}"`);
    return found;
}

export function computeCanonicalOwnershipKey(taskPath: string, manifest: RepositoryManifest): OwnershipKey {
    const owner = getOwningOccurrence(taskPath, manifest);
    if (!owner) throw new Error(`no occurrence owns path "${taskPath}"`);
    const pathWithinRepo = getPathWithinRepository(taskPath, owner);
    const logicalRepository = findLogicalRepository(owner.occurrenceId, manifest);
    return { canonicalOccurrenceId: logicalRepository.canonicalOccurrenceId, pathWithinRepo };
}

export function expandOwnershipEffects(key: OwnershipKey, manifest: RepositoryManifest): OwnershipEffects {
    const logicalRepository = findLogicalRepository(key.canonicalOccurrenceId, manifest);
    const occurrenceById = new Map(manifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
    const occurrencePaths: string[] = [];
    const ancestorGitlinks = new Set<string>();

    for (const occurrenceId of logicalRepository.occurrenceIds) {
        const occurrence = occurrenceById.get(occurrenceId);
        if (!occurrence) throw new Error(`missing occurrence for ID "${occurrenceId}"`);
        occurrencePaths.push(
            key.pathWithinRepo === "" ? occurrence.checkoutPath : `${occurrence.checkoutPath}/${key.pathWithinRepo}`,
        );
        for (const ancestor of getAncestorChain(occurrence, manifest)) {
            ancestorGitlinks.add(ancestor.checkoutPath);
        }
    }

    return { key, occurrencePaths, ancestorGitlinks: [...ancestorGitlinks] };
}

export function expandTaskPathEffects(taskPath: string, manifest: RepositoryManifest): OwnershipEffects {
    return expandOwnershipEffects(computeCanonicalOwnershipKey(taskPath, manifest), manifest);
}
