// basePublication.ts: local base publication with CAS, whole-run rollback, and recovery reporting.  Phase 4 of the recursive repository-discovery redesign.
import { spawnSync } from "node:child_process";
import { checkAuthorizationDrift } from "./approvalGate.ts";
import type { RunState } from "./approvalGate.ts";

export type LogicalRepository = {
    name: string;
    canonicalOccurrencePath: string;
    canonicalRefName: string;
    otherOccurrences: { path: string; refName: string }[];
    recordedBaseOid: string;
    targetOid: string;
};

export type UpdatedRef = {
    repoName: string;
    occurrencePath: string;
    refName: string;
    recordedOid: string;
    newOid: string;
};

export type RollbackOutcome = {
    ref: UpdatedRef;
    rolledBack: boolean;
    recoveryCommand: string;
};

export type PublicationResult = {
    published: boolean;
    rollback: RollbackOutcome[];
};

function runGit(repoPath: string, args: string[]): { ok: boolean; stdout: string } {
    const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
    return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

export function readCurrentRefOid(repoPath: string, refName: string): string | null {
    const result = runGit(repoPath, ["rev-parse", "--verify", "--quiet", refName]);
    return result.ok ? result.stdout.trim() : null;
}

export function checkRootIntegrationOidExists(repoPath: string, rootIntegrationRef: string): boolean {
    return readCurrentRefOid(repoPath, rootIntegrationRef) !== null;
}

export function revalidateRecordedBaseOids(repos: LogicalRepository[]): { ok: boolean; moved: LogicalRepository[] } {
    const moved = repos.filter(
        (repo) => readCurrentRefOid(repo.canonicalOccurrencePath, repo.canonicalRefName) !== repo.recordedBaseOid,
    );
    return { ok: moved.length === 0, moved };
}

export function revalidateApprovalInputs(approvalState: RunState): boolean {
    return checkAuthorizationDrift(approvalState);
}

export function publishCanonicalRef(repo: LogicalRepository): { ok: boolean; updated?: UpdatedRef } {
    const result = runGit(repo.canonicalOccurrencePath, [
        "update-ref",
        repo.canonicalRefName,
        repo.targetOid,
        repo.recordedBaseOid,
    ]);
    if (!result.ok) return { ok: false };
    return {
        ok: true,
        updated: {
            repoName: repo.name,
            occurrencePath: repo.canonicalOccurrencePath,
            refName: repo.canonicalRefName,
            recordedOid: repo.recordedBaseOid,
            newOid: repo.targetOid,
        },
    };
}

export function fastForwardOtherOccurrences(
    repo: LogicalRepository,
): { ok: boolean; updated: UpdatedRef[]; failedAt?: string } {
    const updated: UpdatedRef[] = [];
    for (const occurrence of repo.otherOccurrences) {
        // No --force: a plain "src:dst" fetch refspec already refuses a non-fast-forward move.
        const result = runGit(occurrence.path, [
            "fetch",
            repo.canonicalOccurrencePath,
            `${repo.canonicalRefName}:${occurrence.refName}`,
        ]);
        if (!result.ok) {
            return { ok: false, updated, failedAt: occurrence.path };
        }
        updated.push({
            repoName: repo.name,
            occurrencePath: occurrence.path,
            refName: occurrence.refName,
            recordedOid: repo.recordedBaseOid,
            newOid: repo.targetOid,
        });
    }
    return { ok: true, updated };
}

export function formatRecoveryCommand(ref: UpdatedRef): string {
    return `git -C ${ref.occurrencePath} update-ref ${ref.refName} ${ref.recordedOid}`;
}

export function rollbackUpdatedRefs(updated: UpdatedRef[]): RollbackOutcome[] {
    return updated.map((ref) => {
        const result = runGit(ref.occurrencePath, ["update-ref", ref.refName, ref.recordedOid, ref.newOid]);
        return { ref, rolledBack: result.ok, recoveryCommand: formatRecoveryCommand(ref) };
    });
}

export function publishBases(
    repos: LogicalRepository[],
    approvalState: RunState,
    rootIntegration: { repoPath: string; refName: string },
): PublicationResult {
    if (!checkRootIntegrationOidExists(rootIntegration.repoPath, rootIntegration.refName)) {
        return { published: false, rollback: [] };
    }
    if (!revalidateApprovalInputs(approvalState)) {
        return { published: false, rollback: [] };
    }
    if (!revalidateRecordedBaseOids(repos).ok) {
        return { published: false, rollback: [] };
    }

    const updatedSoFar: UpdatedRef[] = [];
    let pass2Failed = false;
    for (const repo of repos) {
        const canonicalResult = publishCanonicalRef(repo);
        if (!canonicalResult.ok) {
            pass2Failed = true;
            break;
        }
        updatedSoFar.push(canonicalResult.updated!);

        const fastForwardResult = fastForwardOtherOccurrences(repo);
        updatedSoFar.push(...fastForwardResult.updated);
        if (!fastForwardResult.ok) {
            pass2Failed = true;
            break;
        }
    }

    if (!pass2Failed) {
        return { published: true, rollback: [] };
    }
    return { published: false, rollback: rollbackUpdatedRefs(updatedSoFar) };
}
