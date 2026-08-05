// In-memory, non-interactive entry point: repoRoot -> resolved occurrence graph or named refusal.
import { REPOSITORY_MANIFEST_VERSION } from "./repositoryManifest.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
import { createEmptyResolutionManifest } from "./resolutionRequests.ts";
import type { ResolutionRequest } from "./resolutionRequests.ts";
import { discoverRepositoryTree } from "./repositoryDiscovery.ts";
import type { DiscoveryManifest } from "./repositoryDiscovery.ts";

export type ManifestBootstrapRefusal = {
    refused: true;
    requests: Array<{ request: ResolutionRequest; reason: string }>;
};

export type ManifestBootstrapResult =
    | { refused: false; occurrenceGraph: RepositoryOccurrence[] }
    | ManifestBootstrapRefusal;

export function bootstrapRepositoryManifest(repoRoot: string): ManifestBootstrapResult {
    const manifest: DiscoveryManifest = {
        repositoryManifest: { version: REPOSITORY_MANIFEST_VERSION, occurrences: [] },
        resolutionManifest: createEmptyResolutionManifest(),
    };

    const result = discoverRepositoryTree(repoRoot, manifest);

    if (result.status === "resolved") {
        return { refused: false, occurrenceGraph: result.graph };
    }

    return {
        refused: true,
        requests: result.resolutionRequests.map((request) => ({ request, reason: request.reason })),
    };
}
