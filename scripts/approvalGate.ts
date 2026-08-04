// approvalGate.ts: the single whole-run approval gate -- records approval, issues authorization, invalidates it on drift.
import { createHash } from "node:crypto";
import type { RepositoryManifest } from "./repositoryManifest.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import { issueRunAuthorization } from "./runAuthorization.ts";
import type { RunAuthorizationToken } from "./runAuthorization.ts";
import { runFinalizer } from "./runFinalizer.ts";
import type { FinalizationRunInput, FinalizationRunResult } from "./runFinalizer.ts";

export type ApprovalDigestInput = {
    manifest: RepositoryManifest;
    files: string[];
    operationRef: string;
    baseRef: string;
    occurrenceDigests: string[];
    testReceipts: TestReceipt[];
    reviewHandoffs: string[];
};

export type Approval = {
    digest: string;
    recordedAt: string;
};

export type RunState = {
    readyForApproval: boolean;
    status: string;
    digestInput: ApprovalDigestInput;
    approval?: Approval;
    authorization?: RunAuthorizationToken;
};

function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>).sort();
        const entries = keys.map(
            (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
        );
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value);
}

export function computeApprovalDigest(input: ApprovalDigestInput): string {
    return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function recordApproval(runState: RunState): Approval {
    if (!runState.readyForApproval) {
        throw new Error("cannot record approval: run is not readyForApproval");
    }
    if (runState.approval !== undefined) {
        throw new Error("cannot record approval: this run already has an approval recorded");
    }
    const approval: Approval = {
        digest: computeApprovalDigest(runState.digestInput),
        recordedAt: new Date().toISOString(),
    };
    runState.approval = approval;
    return approval;
}

export function issueApprovalAuthorization(runState: RunState): RunAuthorizationToken {
    if (runState.approval === undefined) {
        throw new Error("cannot issue authorization before an approval is recorded");
    }
    const authorization = issueRunAuthorization(runState.approval.digest);
    runState.authorization = authorization;
    return authorization;
}

// Recomputes the digest; a mismatch invalidates approval/authorization and returns the run to review.
export function checkAuthorizationDrift(runState: RunState): boolean {
    if (runState.authorization === undefined) return true;
    const currentDigest = computeApprovalDigest(runState.digestInput);
    if (currentDigest === runState.authorization.stateDigest) return true;
    runState.authorization = undefined;
    runState.approval = undefined;
    runState.status = "review";
    return false;
}

export function finalizeApprovedRun(
    runState: RunState,
    finalizationInput: FinalizationRunInput,
): FinalizationRunResult {
    if (runState.authorization === undefined) {
        throw new Error("cannot finalize: run has no issued authorization");
    }
    return runFinalizer(finalizationInput, runState.authorization, computeApprovalDigest(runState.digestInput));
}
