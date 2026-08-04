// Phase 3 consolidation: fold occurrence branches into one operation branch per logical repository.
import { execFileSync } from "node:child_process";
import {
    prepareNoFfMerge,
    substituteGitlinksRecursively,
} from "./repositoryIntegration.ts";
import type { GitlinkChainLink, RepositoryQualifiedConflict } from "./repositoryIntegration.ts";
import { runFinalization } from "./runAuthorization.ts";
import type { RunAuthorizationToken } from "./runAuthorization.ts";

export interface GroupOccurrenceBranch {
    groupId: string;
    occurrencePath: string;
    occurrenceId: string;
    branchOid: string;
    sourceRepoRoot: string;
}

export interface LogicalRepositoryConsolidationInput {
    logicalRepositoryId: string;
    canonicalRepoRoot: string;
    canonicalOccurrenceBranchName: string;
    participatingBranches: GroupOccurrenceBranch[];
    approvedConvergedTreeOid: string;
    finalizedChildGitlinks: GitlinkChainLink[];
    recordedBaseOid: string;
    baseBranchRef: string;
}

export interface FastForwardedBranch {
    occurrenceId: string;
    branchRef: string;
    oid: string;
}

export interface RunConsolidationSuccess {
    logicalRepositoryId: string;
    operationBranchRef: string;
    operationOid: string;
    fastForwardedOccurrenceBranches: FastForwardedBranch[];
    preparedIntegrationOid: string;
}

export interface RunConsolidationAbort {
    logicalRepositoryId: string;
    aborted: {
        reason: "conflict" | "tree-mismatch";
        conflicts?: RepositoryQualifiedConflict[];
        preservedRefs: string[];
    };
}

export type RunConsolidationResult = RunConsolidationSuccess | RunConsolidationAbort;

function runGit(repoRoot: string, args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

export function sortParticipatingBranches(branches: GroupOccurrenceBranch[]): GroupOccurrenceBranch[] {
    return [...branches].sort((a, b) => {
        const groupCompare = a.groupId.localeCompare(b.groupId);
        if (groupCompare !== 0) return groupCompare;
        return a.occurrencePath.localeCompare(b.occurrencePath);
    });
}

// ponytail: branch ref = groupId/occurrencePath, the only fields that jointly identify a branch here.
function branchRefFor(branch: GroupOccurrenceBranch): string {
    return `refs/heads/${branch.groupId}/${branch.occurrencePath}`;
}

function fetchBranchIntoCanonicalRepo(canonicalRepoRoot: string, branch: GroupOccurrenceBranch): void {
    if (branch.sourceRepoRoot === canonicalRepoRoot) return;
    runGit(canonicalRepoRoot, ["fetch", branch.sourceRepoRoot, branch.branchOid]);
}

function foldMergeParticipatingBranches(
    canonicalRepoRoot: string,
    sorted: GroupOccurrenceBranch[],
    runId: string,
): { merged: true; assemblyOid: string } | { merged: false; conflict: RepositoryQualifiedConflict } {
    let assemblyOid = sorted[0].branchOid;
    for (let i = 1; i < sorted.length; i++) {
        const branch = sorted[i];
        fetchBranchIntoCanonicalRepo(canonicalRepoRoot, branch);
        const result = prepareNoFfMerge(
            canonicalRepoRoot,
            assemblyOid,
            branch.branchOid,
            `runConsolidation ${runId}: fold ${branch.groupId}/${branch.occurrencePath}`,
        );
        if (!result.merged) return result;
        assemblyOid = result.commitOid;
    }
    return { merged: true, assemblyOid };
}

function getTreeOidForCommit(repoRoot: string, commitOid: string): string {
    return runGit(repoRoot, ["rev-parse", `${commitOid}^{tree}`]);
}

function computeExpectedTreeOid(approvedConvergedTreeOid: string, finalizedChildGitlinks: GitlinkChainLink[]): string {
    if (finalizedChildGitlinks.length === 0) return approvedConvergedTreeOid;
    const { rootCommitOid } = substituteGitlinksRecursively(finalizedChildGitlinks, approvedConvergedTreeOid);
    return getTreeOidForCommit(finalizedChildGitlinks[0].repoRoot, rootCommitOid);
}

function buildOperationBranchRef(runId: string, canonicalOccurrenceBranchName: string): string {
    return `refs/heads/operations/${runId}/${canonicalOccurrenceBranchName}`;
}

function moveRefFastForward(repoRoot: string, refName: string, newOid: string, expectedOldOid?: string): void {
    const args = expectedOldOid === undefined ? [refName, newOid] : [refName, newOid, expectedOldOid];
    runGit(repoRoot, ["update-ref", ...args]);
}

export function consolidateLogicalRepository(
    input: LogicalRepositoryConsolidationInput,
    runId: string,
): RunConsolidationResult {
    const { logicalRepositoryId, canonicalRepoRoot, canonicalOccurrenceBranchName, baseBranchRef, recordedBaseOid } =
        input;
    const sorted = sortParticipatingBranches(input.participatingBranches);
    const preservedRefs = [baseBranchRef, ...sorted.map(branchRefFor)];

    const foldResult = foldMergeParticipatingBranches(canonicalRepoRoot, sorted, runId);
    if (!foldResult.merged) {
        return {
            logicalRepositoryId,
            aborted: { reason: "conflict", conflicts: [foldResult.conflict], preservedRefs },
        };
    }
    const { assemblyOid } = foldResult;

    const actualTreeOid = getTreeOidForCommit(canonicalRepoRoot, assemblyOid);
    const expectedTreeOid = computeExpectedTreeOid(input.approvedConvergedTreeOid, input.finalizedChildGitlinks);
    if (actualTreeOid !== expectedTreeOid) {
        return { logicalRepositoryId, aborted: { reason: "tree-mismatch", preservedRefs } };
    }

    const integrationResult = prepareNoFfMerge(
        canonicalRepoRoot,
        recordedBaseOid,
        assemblyOid,
        `runConsolidation ${runId}: integrate ${logicalRepositoryId}`,
    );
    if (!integrationResult.merged) {
        return {
            logicalRepositoryId,
            aborted: { reason: "conflict", conflicts: [integrationResult.conflict], preservedRefs },
        };
    }

    const operationBranchRef = buildOperationBranchRef(runId, canonicalOccurrenceBranchName);
    moveRefFastForward(canonicalRepoRoot, operationBranchRef, assemblyOid);

    const fastForwardedOccurrenceBranches: FastForwardedBranch[] = sorted.map((branch) => {
        const branchRef = branchRefFor(branch);
        moveRefFastForward(canonicalRepoRoot, branchRef, assemblyOid, branch.branchOid);
        return { occurrenceId: branch.occurrenceId, branchRef, oid: assemblyOid };
    });

    return {
        logicalRepositoryId,
        operationBranchRef,
        operationOid: assemblyOid,
        fastForwardedOccurrenceBranches,
        preparedIntegrationOid: integrationResult.commitOid,
    };
}

function validateRunAuthorization(token: RunAuthorizationToken, currentStateDigest: string): void {
    runFinalization(token, currentStateDigest, () => undefined);
}

export function consolidateRun(
    runId: string,
    logicalRepositories: LogicalRepositoryConsolidationInput[],
    token: RunAuthorizationToken,
    currentStateDigest: string,
): RunConsolidationResult[] {
    validateRunAuthorization(token, currentStateDigest);
    return logicalRepositories.map((input) => consolidateLogicalRepository(input, runId));
}
