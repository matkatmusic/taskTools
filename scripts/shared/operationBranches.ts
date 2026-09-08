// Creates per-occurrence operation branches at their recorded base OID, checks them out, and records the branch name.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
import { normalizeRepositoryIdentity } from "./submoduleUrlIdentity.ts";
import { HEAD_DETACHED, HEAD_ON_BRANCH } from "./resultCodes.ts";

export class OperationBranchSetupError extends Error {}
export class OperationBranchConflictError extends Error {}

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function isDetachedHead(repoPath: string): number {
    try {
        execFileSync("git", ["-C", repoPath, "symbolic-ref", "-q", "HEAD"], { stdio: "ignore" });
        return HEAD_ON_BRANCH;
    } catch {
        return HEAD_DETACHED;
    }
}

function validateOccurrencesReadyForBranching(occurrences: RepositoryOccurrence[]): void {
    const problems: string[] = [];
    for (const occurrence of occurrences) {
        if (isDetachedHead(occurrence.checkoutPath) === HEAD_DETACHED) {
            problems.push(`  - ${occurrence.checkoutPath}: detached HEAD`);
        } else if (occurrence.baseBranch === "") {
            problems.push(`  - ${occurrence.checkoutPath}: baseBranch not resolved`);
        }
    }
    if (problems.length > 0) {
        throw new OperationBranchSetupError(
            `Cannot set up operation branches, ${problems.length} occurrence(s) not ready:\n${problems.join("\n")}`,
        );
    }
}

export function operationBranchName(runId: string, occurrence: RepositoryOccurrence): string {
    const occurrenceSegment = occurrence.occurrenceId === "" ? "root" : occurrence.occurrenceId;
    return `operations/${runId}/${occurrenceSegment}`;
}

export function sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^A-Za-z0-9_-]/g, "-") || "seg";
    return `${cleaned}-${createHash("sha256").update(segment).digest("hex").slice(0, 8)}`;
}

export function identityKey(occurrence: RepositoryOccurrence): string {
    if (occurrence.originUrl === "") return `blank:${occurrence.occurrenceId}`;
    const parsed = normalizeRepositoryIdentity(occurrence.originUrl);
    return parsed ? `parsed:${parsed.host}/${parsed.owner}/${parsed.repository}` : `opaque:${occurrence.originUrl}`;
}

function branchOid(repoPath: string, branchName: string): string | null {
    try {
        return git(repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`);
    } catch {
        return null;
    }
}

function ensureOperationBranchAtOid(repoPath: string, branchName: string, recordedOid: string): void {
    const existingOid = branchOid(repoPath, branchName);
    if (existingOid === null) {
        git(repoPath, "branch", branchName, recordedOid);
        return;
    }
    if (existingOid !== recordedOid) {
        throw new OperationBranchConflictError(
            `Operation branch conflict at ${repoPath}: branch "${branchName}" expected to point at ${recordedOid} but points at ${existingOid}`,
        );
    }
}

export function setUpOperationBranches(
    occurrences: RepositoryOccurrence[],
    runId: string,
): RepositoryOccurrence[] {
    validateOccurrencesReadyForBranching(occurrences);
    return occurrences.map((occurrence) => {
        const branchName = operationBranchName(runId, occurrence);
        ensureOperationBranchAtOid(occurrence.checkoutPath, branchName, occurrence.baseOid);
        git(occurrence.checkoutPath, "checkout", branchName);
        return { ...occurrence, operationBranch: branchName };
    });
}

export function buildOperationPushOccurrences(
    occurrences: RepositoryOccurrence[],
    runId: string,
): RepositoryOccurrence[] {
    const logicalIdByIdentity = new Map<string, string>();
    for (const occurrence of occurrences) {
        const key = identityKey(occurrence);
        if (!logicalIdByIdentity.has(key)) logicalIdByIdentity.set(key, sanitizeSegment(key));
    }
    return occurrences.map((occurrence) => {
        const logicalId = logicalIdByIdentity.get(identityKey(occurrence))!;
        return { ...occurrence, operationBranch: `operations/${runId}/${sanitizeSegment(logicalId)}` };
    });
}
