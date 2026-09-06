// basePublication.ts: local base publication with CAS, whole-run rollback, and recovery reporting.  Phase 4 of the recursive repository-discovery redesign.
import { spawnSync } from "node:child_process";
import { checkAuthorizationDrift } from "./approvalGate.ts";
import type { RunState } from "./approvalGate.ts";
import {
    ROOT_INTEGRATION_OID_EXISTS, ROOT_INTEGRATION_OID_MISSING, APPROVAL_INPUTS_STILL_AUTHORIZED, APPROVAL_INPUTS_DRIFTED,
    CHECKOUT_TRANSITION_OK, CHECKOUT_TRANSITION_FAILED,
} from "./resultCodes.ts";
import { AUTHORIZATION_DRIFT_NOT_DETECTED } from "./resultCodes.ts";

export type PublicationTarget = {
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

export type CheckoutTransition = {
    repoName: string;
    occurrencePath: string;
    refName: string;
    oldOid: string;
    newOid: string;
};

export type CheckoutRollbackOutcome = {
    transition: CheckoutTransition;
    rolledBack: boolean;
    recoveryCommand: string;
};

export type PublicationResult = {
    published: boolean;
    rollback: RollbackOutcome[];
    checkoutRollback: CheckoutRollbackOutcome[];
};

function runGit(repoPath: string, args: string[]): { ok: boolean; stdout: string } {
    const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
    return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

export function readCurrentRefOid(repoPath: string, refName: string): string | null {
    const result = runGit(repoPath, ["rev-parse", "--verify", "--quiet", refName]);
    return result.ok ? result.stdout.trim() : null;
}

export function checkRootIntegrationOidExists(repoPath: string, rootIntegrationRef: string): number {
    return readCurrentRefOid(repoPath, rootIntegrationRef) !== null ? ROOT_INTEGRATION_OID_EXISTS : ROOT_INTEGRATION_OID_MISSING;
}

export function revalidateRecordedBaseOids(repos: PublicationTarget[]): { ok: boolean; moved: PublicationTarget[] } {
    const moved = repos.filter(
        (repo) => readCurrentRefOid(repo.canonicalOccurrencePath, repo.canonicalRefName) !== repo.recordedBaseOid,
    );
    return { ok: moved.length === 0, moved };
}

export function revalidateApprovalInputs(approvalState: RunState): number {
    return checkAuthorizationDrift(approvalState) === AUTHORIZATION_DRIFT_NOT_DETECTED ? APPROVAL_INPUTS_STILL_AUTHORIZED : APPROVAL_INPUTS_DRIFTED;
}

export function publishCanonicalRef(repo: PublicationTarget): { ok: boolean; updated?: UpdatedRef } {
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
    repo: PublicationTarget,
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

function checkedOutTransition(repo: PublicationTarget): CheckoutTransition | null {
    const head = runGit(repo.canonicalOccurrencePath, ["symbolic-ref", "--quiet", "HEAD"]);
    if (!head.ok || head.stdout.trim() !== repo.canonicalRefName) return null;
    return {
        repoName: repo.name,
        occurrencePath: repo.canonicalOccurrencePath,
        refName: repo.canonicalRefName,
        oldOid: repo.recordedBaseOid,
        newOid: repo.targetOid,
    };
}

function runCheckoutTransition(
    transition: CheckoutTransition,
    oldOid: string,
    newOid: string,
    dryRun: boolean,
): number {
    const args = ["read-tree", "--no-recurse-submodules"];
    if (dryRun) args.push("-n");
    args.push("-u", "-m", oldOid, newOid);
    return runGit(transition.occurrencePath, args).ok ? CHECKOUT_TRANSITION_OK : CHECKOUT_TRANSITION_FAILED;
}

function preflightCheckoutTransition(transition: CheckoutTransition): number {
    return runCheckoutTransition(transition, transition.oldOid, transition.newOid, true);
}

function applyCheckoutTransition(transition: CheckoutTransition): number {
    return runCheckoutTransition(transition, transition.oldOid, transition.newOid, false);
}

function formatCheckoutRecoveryCommand(transition: CheckoutTransition): string {
    return `git -C ${transition.occurrencePath} read-tree --no-recurse-submodules -u -m ${transition.newOid} ${transition.oldOid}`;
}

function rollbackCheckoutTransitions(applied: CheckoutTransition[]): CheckoutRollbackOutcome[] {
    return [...applied].reverse().map((transition) => ({
        transition,
        rolledBack: runCheckoutTransition(transition, transition.newOid, transition.oldOid, false) === CHECKOUT_TRANSITION_OK,
        recoveryCommand: formatCheckoutRecoveryCommand(transition),
    }));
}

export type CheckoutOperations = {
    preflight: (transition: CheckoutTransition) => number;
    apply: (transition: CheckoutTransition) => number;
    rollback: (applied: CheckoutTransition[]) => CheckoutRollbackOutcome[];
};

export const defaultCheckoutOperations: CheckoutOperations = {
    preflight: preflightCheckoutTransition,
    apply: applyCheckoutTransition,
    rollback: rollbackCheckoutTransitions,
};

export function publishBases(
    repos: PublicationTarget[],
    approvalState: RunState,
    rootIntegration: { repoPath: string; refName: string },
    checkoutOperations: CheckoutOperations = defaultCheckoutOperations,
): PublicationResult {
    const notPublished = (): PublicationResult => ({
        published: false,
        rollback: [],
        checkoutRollback: [],
    });

    if (checkRootIntegrationOidExists(rootIntegration.repoPath, rootIntegration.refName) !== ROOT_INTEGRATION_OID_EXISTS) {
        return notPublished();
    }
    if (revalidateApprovalInputs(approvalState) !== APPROVAL_INPUTS_STILL_AUTHORIZED) {
        return notPublished();
    }
    if (!revalidateRecordedBaseOids(repos).ok) {
        return notPublished();
    }

    const checkoutTransitions = repos.flatMap((repo) => {
        const transition = checkedOutTransition(repo);
        return transition === null ? [] : [transition];
    });
    if (!checkoutTransitions.every((transition) => checkoutOperations.preflight(transition) === CHECKOUT_TRANSITION_OK)) {
        return notPublished();
    }

    const updatedSoFar: UpdatedRef[] = [];
    for (const repo of repos) {
        const canonicalResult = publishCanonicalRef(repo);
        if (!canonicalResult.ok) {
            return {
                published: false,
                rollback: rollbackUpdatedRefs(updatedSoFar),
                checkoutRollback: [],
            };
        }
        updatedSoFar.push(canonicalResult.updated!);

        const fastForwardResult = fastForwardOtherOccurrences(repo);
        updatedSoFar.push(...fastForwardResult.updated);
        if (!fastForwardResult.ok) {
            return {
                published: false,
                rollback: rollbackUpdatedRefs(updatedSoFar),
                checkoutRollback: [],
            };
        }
    }

    const appliedTransitions: CheckoutTransition[] = [];
    for (const transition of checkoutTransitions) {
        if (checkoutOperations.apply(transition) !== CHECKOUT_TRANSITION_OK) {
            const checkoutRollback = checkoutOperations.rollback(appliedTransitions);
            const rollback = rollbackUpdatedRefs(updatedSoFar);
            return { published: false, rollback, checkoutRollback };
        }
        appliedTransitions.push(transition);
    }

    return { published: true, rollback: [], checkoutRollback: [] };
}
