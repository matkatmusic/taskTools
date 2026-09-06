// Groups occurrence-tree entries sharing an upstream identity into LogicalRepository records.  Read-only overlay; plain strings/arrays -- already the run-manifest-ready shape.
import { createHash } from "node:crypto";
import { normalizeRepositoryIdentity } from "./submoduleUrlIdentity.ts";
import type { RepositoryIdentity } from "./submoduleUrlIdentity.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";

export type ConsolidationState = "single" | "grouped";

export interface LogicalRepository {
    normalizedIdentity: RepositoryIdentity;
    occurrenceIds: string[];
    selectedBaseOccurrenceId: string;
    canonicalOccurrenceId: string;
    lastWriterOccurrenceId: string;
    convergenceDigest: string;
    consolidationState: ConsolidationState;
}

function identityToMapKey(identity: RepositoryIdentity): string {
    return `${identity.host}/${identity.owner}/${identity.repository}`;
}

function digestOccurrenceIds(occurrenceIds: string[]): string {
    const sorted = [...occurrenceIds].sort();
    return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

function buildLogicalRepositoryFromGroup(
    identity: RepositoryIdentity,
    group: RepositoryOccurrence[],
): LogicalRepository {
    const occurrenceIds = group.map((occurrence) => occurrence.occurrenceId);
    const canonicalOccurrenceId = occurrenceIds[0];
    // ponytail: no write-timestamp field on RepositoryOccurrence yet; last writer == last discovered until real mtime/write tracking exists upstream.
    const lastWriterOccurrenceId = occurrenceIds[occurrenceIds.length - 1];
    // ponytail: no base-selection policy specified by the brief; base defaults to canonical until a future task defines real selection.
    const selectedBaseOccurrenceId = canonicalOccurrenceId;
    return {
        normalizedIdentity: identity,
        occurrenceIds,
        selectedBaseOccurrenceId,
        canonicalOccurrenceId,
        lastWriterOccurrenceId,
        convergenceDigest: digestOccurrenceIds(occurrenceIds),
        consolidationState: occurrenceIds.length === 1 ? "single" : "grouped",
    };
}

export function buildLogicalRepositories(occurrences: RepositoryOccurrence[]): LogicalRepository[] {
    const groupsByIdentityKey = new Map<string, { identity: RepositoryIdentity; occurrences: RepositoryOccurrence[] }>();
    for (const occurrence of occurrences) {
        const identity = normalizeRepositoryIdentity(occurrence.originUrl);
        if (identity === null) {
            throw new Error(
                `occurrence "${occurrence.occurrenceId}" has an unparseable origin URL: "${occurrence.originUrl}"`,
            );
        }
        const key = identityToMapKey(identity);
        const existingGroup = groupsByIdentityKey.get(key);
        if (existingGroup) {
            existingGroup.occurrences.push(occurrence);
        } else {
            groupsByIdentityKey.set(key, { identity, occurrences: [occurrence] });
        }
    }
    return Array.from(groupsByIdentityKey.values()).map(({ identity, occurrences: group }) =>
        buildLogicalRepositoryFromGroup(identity, group),
    );
}
