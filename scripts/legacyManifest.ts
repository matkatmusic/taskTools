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

const RECOVERY_COMMANDS = [
    "inspect the worktrees listed in this manifest manually before rerunning",
    "run `git worktree list` in the repository to see what checkouts still exist",
    "run `git branch --list` to see what operation branches still exist",
];

export function checkLegacyManifest(manifest: unknown): LegacyManifestCheck {
    const version = (manifest as { version?: number } | null | undefined)?.version;

    if (version === undefined || version === null) {
        return {
            ok: false,
            detectedVersion: undefined,
            reason: "manifest predates version tracking (flat repository-path model)",
            recoveryCommands: RECOVERY_COMMANDS,
        };
    }

    if (version < REPOSITORY_MANIFEST_VERSION) {
        return {
            ok: false,
            detectedVersion: version,
            reason: `manifest version ${version} is older than current version ${REPOSITORY_MANIFEST_VERSION}`,
            recoveryCommands: RECOVERY_COMMANDS,
        };
    }

    return { ok: true };
}
