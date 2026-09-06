// Pushes canonical occurrences' operation branches, never force, with pre-push ancestor check and post-push verification.
import { execFileSync } from "node:child_process";
import type { LogicalRepository } from "./logicalRepository.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
import { runFinalization } from "./runAuthorization.ts";
import type { RunAuthorizationToken } from "./runAuthorization.ts";

export class RunNotApprovedError extends Error {}
export class NonAncestorRemoteTipError extends Error {}
export class OccurrenceVerificationMismatchError extends Error {}

export type OperationPushInput = {
    logicalRepositories: LogicalRepository[];
    occurrences: RepositoryOccurrence[];
};

export type PushResult =
    | { kind: "skipped-unique"; convergenceDigest: string }
    | { kind: "pushed"; convergenceDigest: string; oid: string };

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

export function buildPushArgv(remote: string, localOid: string, branchName: string): string[] {
    return ["push", remote, `${localOid}:refs/heads/${branchName}`];
}

function requireOccurrence(occurrenceById: Map<string, RepositoryOccurrence>, occurrenceId: string): RepositoryOccurrence {
    const occurrence = occurrenceById.get(occurrenceId);
    if (!occurrence) {
        throw new Error(`no occurrence found for occurrenceId "${occurrenceId}"`);
    }
    return occurrence;
}

function resolveRemoteTip(repoPath: string, remote: string, branchName: string): string | null {
    const output = git(repoPath, "ls-remote", remote, branchName);
    if (output === "") return null;
    return output.split("\t")[0];
}

function verifyOtherOccurrence(
    occurrence: RepositoryOccurrence,
    remote: string,
    branchName: string,
    canonicalOid: string,
    canonicalTree: string,
): void {
    git(occurrence.checkoutPath, "fetch", remote, branchName);
    const fetchedOid = git(occurrence.checkoutPath, "rev-parse", "FETCH_HEAD");
    const fetchedTree = git(occurrence.checkoutPath, "rev-parse", "FETCH_HEAD^{tree}");
    if (fetchedOid !== canonicalOid || fetchedTree !== canonicalTree) {
        throw new OccurrenceVerificationMismatchError(
            `occurrence "${occurrence.occurrenceId}" verification mismatch: expected oid ${canonicalOid} tree ${canonicalTree}, got oid ${fetchedOid} tree ${fetchedTree}`,
        );
    }
}

function pushLogicalRepository(
    logicalRepository: LogicalRepository,
    occurrenceById: Map<string, RepositoryOccurrence>,
): PushResult {
    if (logicalRepository.occurrenceIds.length === 1) {
        return { kind: "skipped-unique", convergenceDigest: logicalRepository.convergenceDigest };
    }

    const canonical = requireOccurrence(occurrenceById, logicalRepository.canonicalOccurrenceId);
    const remote = canonical.originUrl;
    const branchName = canonical.operationBranch;
    const localOid = git(canonical.checkoutPath, "rev-parse", branchName);

    const remoteTip = resolveRemoteTip(canonical.checkoutPath, remote, branchName);
    if (remoteTip !== null) {
        try {
            git(canonical.checkoutPath, "merge-base", "--is-ancestor", remoteTip, localOid);
        } catch {
            throw new NonAncestorRemoteTipError(
                `remote tip ${remoteTip} for branch "${branchName}" is not an ancestor of local OID ${localOid}`,
            );
        }
    }

    execFileSync("git", ["-C", canonical.checkoutPath, ...buildPushArgv(remote, localOid, branchName)], { encoding: "utf8" });

    const canonicalTree = git(canonical.checkoutPath, "rev-parse", `${localOid}^{tree}`);
    for (const occurrenceId of logicalRepository.occurrenceIds) {
        if (occurrenceId === logicalRepository.canonicalOccurrenceId) continue;
        const other = requireOccurrence(occurrenceById, occurrenceId);
        verifyOtherOccurrence(other, remote, branchName, localOid, canonicalTree);
    }

    return { kind: "pushed", convergenceDigest: logicalRepository.convergenceDigest, oid: localOid };
}

function pushAllLogicalRepositories(input: OperationPushInput): PushResult[] {
    const occurrenceById = new Map(input.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
    return input.logicalRepositories.map((logicalRepository) => pushLogicalRepository(logicalRepository, occurrenceById));
}

export async function pushOperationBranches(
    input: OperationPushInput,
    token: RunAuthorizationToken,
    currentStateDigest: string,
): Promise<PushResult[]> {
    let approvalPassed = false;
    try {
        return runFinalization(token, currentStateDigest, () => {
            approvalPassed = true;
            return pushAllLogicalRepositories(input);
        });
    } catch (error) {
        if (approvalPassed) throw error;
        throw new RunNotApprovedError(error instanceof Error ? error.message : String(error));
    }
}
