// resolutionRequests.ts: resumable discovery resolution requests with persisted answers.
import { createHash } from "node:crypto";

export type ResolutionReason = string;

export const REASON_ZERO_EXACT_TIP_MATCHES: ResolutionReason = "zero-exact-tip-matches";
export const REASON_MULTIPLE_EXACT_TIP_MATCHES: ResolutionReason = "multiple-exact-tip-matches";
export const REASON_BASE_RECONCILIATION: ResolutionReason = "base-reconciliation";

export interface ResolutionRequest {
    id: string;
    occurrenceId: string;
    recordedOid: string;
    candidateBaseBranches: string[];
    reason: ResolutionReason;
}

export interface BaseReconciliationMember {
    occurrenceId: string;
    recordedOid: string;
    baseBranch: string;
}

export interface BaseReconciliationChoice {
    recordedOid: string;
    baseBranch: string;
}

export interface BaseReconciliationRequest {
    id: string;
    logicalRepositoryId: string;
    members: BaseReconciliationMember[];
    reason: ResolutionReason;
}

export interface ResolutionManifest {
    resolutionRequests: ResolutionRequest[];
    resolutionAnswers: Record<string, string>;
    baseReconciliationRequests: BaseReconciliationRequest[];
    baseReconciliationAnswers: Record<string, BaseReconciliationChoice>;
}

export function createResolutionRequestId(subjectId: string, reason: ResolutionReason): string {
    const hash = createHash("sha256").update(`${subjectId}::${reason}`).digest("hex");
    return `rr_${hash.slice(0, 16)}`;
}

export function createEmptyResolutionManifest(): ResolutionManifest {
    return {
        resolutionRequests: [],
        resolutionAnswers: {},
        baseReconciliationRequests: [],
        baseReconciliationAnswers: {},
    };
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

export function createBaseReconciliationRequest(
    logicalRepositoryId: string,
    members: BaseReconciliationMember[]
): BaseReconciliationRequest {
    return {
        id: createResolutionRequestId(logicalRepositoryId, REASON_BASE_RECONCILIATION),
        logicalRepositoryId,
        members,
        reason: REASON_BASE_RECONCILIATION,
    };
}

export function recordResolutionRequest(manifest: ResolutionManifest, request: ResolutionRequest): void {
    const alreadyRecorded = manifest.resolutionRequests.some((existing) => existing.id === request.id);
    if (alreadyRecorded) return;
    manifest.resolutionRequests.push(request);
}

export function recordBaseReconciliationRequest(
    manifest: ResolutionManifest,
    request: BaseReconciliationRequest
): void {
    const existingIndex = manifest.baseReconciliationRequests.findIndex(
        (existing) => existing.id === request.id
    );
    if (existingIndex === -1) {
        manifest.baseReconciliationRequests.push(request);
        return;
    }
    manifest.baseReconciliationRequests[existingIndex] = request;
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
        const isReconciliationRequest = manifest.baseReconciliationRequests.some(
            (candidate) => candidate.id === requestId
        );
        if (isReconciliationRequest) {
            throw new Error(
                `Request "${requestId}" is a base-reconciliation request; use applyBaseReconciliationAnswers instead of applyResolutionAnswers`
            );
        }
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

export function hasBaseReconciliationAnswer(manifest: ResolutionManifest, requestId: string): boolean {
    return Object.prototype.hasOwnProperty.call(manifest.baseReconciliationAnswers, requestId);
}

export function applyBaseReconciliationAnswers(
    manifest: ResolutionManifest,
    answers: Record<string, BaseReconciliationChoice>
): void {
    for (const [requestId, choice] of Object.entries(answers)) {
        const request = manifest.baseReconciliationRequests.find((candidate) => candidate.id === requestId);
        if (!request) {
            throw new Error(`No base reconciliation request found with id "${requestId}"`);
        }
        const matchesRecordedMember = request.members.some(
            (member) => member.recordedOid === choice.recordedOid && member.baseBranch === choice.baseBranch
        );
        if (!matchesRecordedMember) {
            throw new Error(
                `{recordedOid: "${choice.recordedOid}", baseBranch: "${choice.baseBranch}"} does not match any member of request "${requestId}"`
            );
        }
        manifest.baseReconciliationAnswers[requestId] = { recordedOid: choice.recordedOid, baseBranch: choice.baseBranch };
    }
}
