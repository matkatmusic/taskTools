// baseReconciliation.ts: base/recorded-OID reconciliation gate for repeated repositories.
import type { ResolutionManifest, BaseReconciliationMember, BaseReconciliationChoice } from "./resolutionRequests.ts";
import { createBaseReconciliationRequest, recordBaseReconciliationRequest } from "./resolutionRequests.ts";

export type BaseReconciliationResult =
    | ({ status: "resolved" } & BaseReconciliationChoice)
    | { status: "blocked"; logicalRepositoryId: string; requestId: string };

function normalizeMemberOrder(members: BaseReconciliationMember[]): BaseReconciliationMember[] {
    return [...members].sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId));
}

function findUnanimousChoice(members: BaseReconciliationMember[]): BaseReconciliationChoice | undefined {
    const [first, ...rest] = members;
    const allAgree = rest.every(
        (member) => member.recordedOid === first.recordedOid && member.baseBranch === first.baseBranch
    );
    if (!allAgree) {
        return undefined;
    }
    return { recordedOid: first.recordedOid, baseBranch: first.baseBranch };
}

export function checkBaseReconciliation(
    logicalRepositoryId: string,
    occurrences: BaseReconciliationMember[],
    manifest: ResolutionManifest
): BaseReconciliationResult {
    if (occurrences.length === 0) {
        throw new Error(
            `checkBaseReconciliation requires at least one occurrence for logical repository "${logicalRepositoryId}"`
        );
    }

    const normalizedMembers = normalizeMemberOrder(occurrences);
    const request = createBaseReconciliationRequest(logicalRepositoryId, normalizedMembers);

    const persistedAnswer = manifest.baseReconciliationAnswers[request.id];
    if (persistedAnswer) {
        return { status: "resolved", recordedOid: persistedAnswer.recordedOid, baseBranch: persistedAnswer.baseBranch };
    }

    const unanimousChoice = findUnanimousChoice(normalizedMembers);
    if (unanimousChoice) {
        return { status: "resolved", recordedOid: unanimousChoice.recordedOid, baseBranch: unanimousChoice.baseBranch };
    }

    recordBaseReconciliationRequest(manifest, request);
    return { status: "blocked", logicalRepositoryId, requestId: request.id };
}

export function assertBaseReconciled(
    logicalRepositoryId: string,
    occurrences: BaseReconciliationMember[],
    manifest: ResolutionManifest
): BaseReconciliationChoice {
    const result = checkBaseReconciliation(logicalRepositoryId, occurrences, manifest);
    if (result.status === "blocked") {
        throw new Error(
            `Base reconciliation blocked for logical repository "${result.logicalRepositoryId}": awaiting answer to request "${result.requestId}"`
        );
    }
    return { recordedOid: result.recordedOid, baseBranch: result.baseBranch };
}
