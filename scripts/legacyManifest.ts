// Detects flat-model (pre-version) run manifests and refuses to proceed, non-destructively.
import { REPOSITORY_MANIFEST_VERSION } from "./repositoryManifest.ts";

export interface LegacyManifestRefusal {
    ok: false;
    detectedVersion: number | undefined; // undefined = versionless manifest
    reason: string;
    recoveryCommands: string[];
}

export interface LegacyManifestPass {
    ok: true;
}

export type LegacyManifestCheck = LegacyManifestRefusal | LegacyManifestPass;

function checkoutPathsOf(manifest: unknown): string[] {
    const repositories = (manifest as { repositories?: Array<{ checkoutPath?: unknown }> } | null | undefined)?.repositories;
    if (!Array.isArray(repositories)) return [];
    return repositories
        .map((repository) => repository?.checkoutPath)
        .filter((checkoutPath): checkoutPath is string => typeof checkoutPath === "string");
}

function recoveryCommandsFor(manifest: unknown): string[] {
    const worktreeCommands = checkoutPathsOf(manifest).map(
        (checkoutPath) => `inspect the worktree at ${checkoutPath} manually before rerunning`,
    );
    return [
        ...worktreeCommands,
        "run `git worktree list` in the repository to see what checkouts still exist",
        "run `git branch --list` to see what operation branches still exist",
    ];
}

export function checkLegacyManifest(manifest: unknown): LegacyManifestCheck {
    const typed = manifest as { version?: number; repositoryManifest?: { version?: number } } | null | undefined;
    const version = typed?.version ?? typed?.repositoryManifest?.version;

    if (version === undefined || version === null) {
        return {
            ok: false,
            detectedVersion: undefined,
            reason: "manifest predates version tracking (flat repository-path model)",
            recoveryCommands: recoveryCommandsFor(manifest),
        };
    }

    if (version < REPOSITORY_MANIFEST_VERSION) {
        return {
            ok: false,
            detectedVersion: version,
            reason: `manifest version ${version} is older than current version ${REPOSITORY_MANIFEST_VERSION}`,
            recoveryCommands: recoveryCommandsFor(manifest),
        };
    }

    return { ok: true };
}
