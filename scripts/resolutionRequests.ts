// resolutionRequests.ts: resumable discovery resolution requests with persisted answers.
import { createHash } from "node:crypto";

export type ResolutionReason = string;

export const REASON_ZERO_EXACT_TIP_MATCHES: ResolutionReason = "zero-exact-tip-matches";
export const REASON_MULTIPLE_EXACT_TIP_MATCHES: ResolutionReason = "multiple-exact-tip-matches";

export interface ResolutionRequest {
    id: string;
    occurrenceId: string;
    recordedOid: string;
    candidateBaseBranches: string[];
    reason: ResolutionReason;
}

export interface ResolutionManifest {
    resolutionRequests: ResolutionRequest[];
    resolutionAnswers: Record<string, string>;
}

export function createResolutionRequestId(occurrenceId: string, reason: ResolutionReason): string {
    const hash = createHash("sha256").update(`${occurrenceId}::${reason}`).digest("hex");
    return `rr_${hash.slice(0, 16)}`;
}

export function createEmptyResolutionManifest(): ResolutionManifest {
    return { resolutionRequests: [], resolutionAnswers: {} };
}

export function createResolutionRequest(
    occurrenceId: string,
    recordedOid: string,
    candidateBaseBranches: string[],
    reason: ResolutionReason
): ResolutionRequest {
    return {
        id: createResolutionRequestId(occurrenceId, reason),
        occurrenceId,
        recordedOid,
        candidateBaseBranches,
        reason,
    };
}

export function recordResolutionRequest(manifest: ResolutionManifest, request: ResolutionRequest): void {
    const alreadyRecorded = manifest.resolutionRequests.some((existing) => existing.id === request.id);
    if (alreadyRecorded) return;
    manifest.resolutionRequests.push(request);
}

export function hasResolutionAnswer(manifest: ResolutionManifest, requestId: string): boolean {
    return Object.prototype.hasOwnProperty.call(manifest.resolutionAnswers, requestId);
}

export function needsResolutionRequest(
    manifest: ResolutionManifest,
    occurrenceId: string,
    reason: ResolutionReason
): boolean {
    const id = createResolutionRequestId(occurrenceId, reason);
    return !hasResolutionAnswer(manifest, id);
}

export function applyResolutionAnswers(manifest: ResolutionManifest, answers: Record<string, string>): void {
    for (const [requestId, selectedBranch] of Object.entries(answers)) {
        const request = manifest.resolutionRequests.find((candidate) => candidate.id === requestId);
        if (!request) {
            throw new Error(`No resolution request found with id "${requestId}"`);
        }
        if (!request.candidateBaseBranches.includes(selectedBranch)) {
            throw new Error(
                `"${selectedBranch}" is not among the candidate base branches for request "${requestId}": ${request.candidateBaseBranches.join(", ")}`
            );
        }
        manifest.resolutionAnswers[requestId] = selectedBranch;
    }
}
