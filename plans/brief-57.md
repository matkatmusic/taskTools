# Task 57: Rename basePublication LogicalRepository to PublicationTarget to end the name collision

Split out of task 53 on 2026-08-05. scripts/basePublication.ts and scripts/logicalRepository.ts both export a type named LogicalRepository and the two are incompatible, so any file importing both has to alias one of them. Codex rejected hiding this behind a local import alias in a single consumer, calling for the real rename.

Rename the basePublication.ts export to PublicationTarget and update every use. The name appears in ten files: scripts/basePublication.ts, scripts/logicalRepository.ts, scripts/operationPush.ts, scripts/ownershipKeys.ts, scripts/runConsolidation.ts, tests/basePublication.test.ts, tests/logicalRepository.test.ts, tests/operationPush.test.ts, tests/runConsolidation.test.ts, tests/testPolicy.test.ts. Check each one to see which of the two types it actually means before editing — scripts/logicalRepository.ts keeps its own LogicalRepository name unchanged.

This is a mechanical rename with no behavior change: typecheck clean and the full suite green with no test assertions rewritten other than the type name itself.

### scripts/basePublication.ts

```
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

```

### scripts/logicalRepository.ts

```
// Groups occurrence-tree entries sharing an upstream identity into LogicalRepository records.  Read-only overlay; plain strings/arrays -- already the run-manifest-ready shape.
import { createHash } from "node:crypto";
import { normalizeRepositoryIdentity } from "./submoduleUrlIdentity.ts";
import type { RepositoryIdentity } from "./submoduleUrlIdentity.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";

export type ConsolidationState = "single" | "grouped";

export interface LogicalRepository {
    normalizedIdentity: RepositoryIdentity;
    occurrenceIds: string[];
    selectedBaseOccurrenceId: string;
    canonicalOccurrenceId: string;
    lastWriterOccurrenceId: string;
    convergenceDigest: string;
    consolidationState: ConsolidationState;
}

function identityToMapKey(identity: RepositoryIdentity): string {
    return `${identity.host}/${identity.owner}/${identity.repository}`;
}

function digestOccurrenceIds(occurrenceIds: string[]): string {
    const sorted = [...occurrenceIds].sort();
    return createHash("sha256").update(sorted.join("\n")).digest("hex");
}

function buildLogicalRepositoryFromGroup(
    identity: RepositoryIdentity,
    group: RepositoryOccurrence[],
): LogicalRepository {
    const occurrenceIds = group.map((occurrence) => occurrence.occurrenceId);
    const canonicalOccurrenceId = occurrenceIds[0];
    // ponytail: no write-timestamp field on RepositoryOccurrence yet; last writer == last discovered until real mtime/write tracking exists upstream.
    const lastWriterOccurrenceId = occurrenceIds[occurrenceIds.length - 1];
    // ponytail: no base-selection policy specified by the brief; base defaults to canonical until a future task defines real selection.
    const selectedBaseOccurrenceId = canonicalOccurrenceId;
    return {
        normalizedIdentity: identity,
        occurrenceIds,
        selectedBaseOccurrenceId,
        canonicalOccurrenceId,
        lastWriterOccurrenceId,
        convergenceDigest: digestOccurrenceIds(occurrenceIds),
        consolidationState: occurrenceIds.length === 1 ? "single" : "grouped",
    };
}

export function buildLogicalRepositories(occurrences: RepositoryOccurrence[]): LogicalRepository[] {
    const groupsByIdentityKey = new Map<string, { identity: RepositoryIdentity; occurrences: RepositoryOccurrence[] }>();
    for (const occurrence of occurrences) {
        const identity = normalizeRepositoryIdentity(occurrence.originUrl);
        if (identity === null) {
            throw new Error(
                `occurrence "${occurrence.occurrenceId}" has an unparseable origin URL: "${occurrence.originUrl}"`,
            );
        }
        const key = identityToMapKey(identity);
        const existingGroup = groupsByIdentityKey.get(key);
        if (existingGroup) {
            existingGroup.occurrences.push(occurrence);
        } else {
            groupsByIdentityKey.set(key, { identity, occurrences: [occurrence] });
        }
    }
    return Array.from(groupsByIdentityKey.values()).map(({ identity, occurrences: group }) =>
        buildLogicalRepositoryFromGroup(identity, group),
    );
}

```

### scripts/operationPush.ts

```
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

```

### scripts/ownershipKeys.ts

```
// Canonicalizes a task path to an ownership key, then expands it to every occurrence path plus ancestor gitlinks.
import type { RepositoryManifest } from "./repositoryManifest.ts";
import { getAncestorChain, getOwningOccurrence, getPathWithinRepository } from "./repositoryGraph.ts";
import { buildLogicalRepositories } from "./logicalRepository.ts";
import type { LogicalRepository } from "./logicalRepository.ts";

export interface OwnershipKey {
    canonicalOccurrenceId: string;
    pathWithinRepo: string;
}

export interface OwnershipEffects {
    key: OwnershipKey;
    occurrencePaths: string[];
    ancestorGitlinks: string[];
}

function findLogicalRepository(occurrenceId: string, manifest: RepositoryManifest): LogicalRepository {
    const logicalRepositories = buildLogicalRepositories(manifest.occurrences);
    const found = logicalRepositories.find((repo) => repo.occurrenceIds.includes(occurrenceId));
    if (!found) throw new Error(`no logical repository found for occurrence "${occurrenceId}"`);
    return found;
}

export function computeCanonicalOwnershipKey(taskPath: string, manifest: RepositoryManifest): OwnershipKey {
    const owner = getOwningOccurrence(taskPath, manifest);
    if (!owner) throw new Error(`no occurrence owns path "${taskPath}"`);
    const pathWithinRepo = getPathWithinRepository(taskPath, owner, manifest);
    const logicalRepository = findLogicalRepository(owner.occurrenceId, manifest);
    return { canonicalOccurrenceId: logicalRepository.canonicalOccurrenceId, pathWithinRepo };
}

export function expandOwnershipEffects(key: OwnershipKey, manifest: RepositoryManifest): OwnershipEffects {
    const logicalRepository = findLogicalRepository(key.canonicalOccurrenceId, manifest);
    const occurrenceById = new Map(manifest.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
    const occurrencePaths: string[] = [];
    const ancestorGitlinks = new Set<string>();

    for (const occurrenceId of logicalRepository.occurrenceIds) {
        const occurrence = occurrenceById.get(occurrenceId);
        if (!occurrence) throw new Error(`missing occurrence for ID "${occurrenceId}"`);
        occurrencePaths.push(
            key.pathWithinRepo === "" ? occurrence.checkoutPath : `${occurrence.checkoutPath}/${key.pathWithinRepo}`,
        );
        for (const ancestor of getAncestorChain(occurrence, manifest)) {
            ancestorGitlinks.add(ancestor.checkoutPath);
        }
    }

    return { key, occurrencePaths, ancestorGitlinks: [...ancestorGitlinks] };
}

export function expandTaskPathEffects(taskPath: string, manifest: RepositoryManifest): OwnershipEffects {
    return expandOwnershipEffects(computeCanonicalOwnershipKey(taskPath, manifest), manifest);
}

```

### scripts/runConsolidation.ts

```
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

```

### tests/basePublication.test.ts

```
// Behavioral checks for basePublication.ts: local base publication with CAS, rollback, recovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    publishBases,
    publishCanonicalRef,
    rollbackUpdatedRefs,
} from "../scripts/basePublication.ts";
import type { LogicalRepository, UpdatedRef } from "../scripts/basePublication.ts";
import type { RunState } from "../scripts/approvalGate.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "base-publication-"));
    git(repoRoot, "init", "-q", "-b", "main");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    return repoRoot;
}

function commitFile(repoPath: string, fileName: string, content: string): string {
    writeFileSync(join(repoPath, fileName), content);
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-q", "-m", fileName);
    return git(repoPath, "rev-parse", "HEAD");
}

function approvedRunState(): RunState {
    return {
        readyForApproval: true,
        status: "approved",
        digestInput: {
            manifest: { version: 1, occurrences: [] },
            files: [],
            operationRef: "refs/operation/1",
            baseRef: "refs/heads/main",
            occurrenceDigests: [],
            testReceipts: [],
            reviewHandoffs: [],
        },
    };
}

function makeRootIntegration(exists: boolean): { repoPath: string; refName: string } {
    const repoPath = makeRepo();
    const refName = "refs/finalize/run-1/tip/root";
    if (exists) {
        const oid = commitFile(repoPath, "root.txt", "root");
        git(repoPath, "update-ref", refName, oid);
    }
    return { repoPath, refName };
}

// Canonical repo: recordedBaseOid on canonicalRefName, later commit as targetOid on "main".
function makeLogicalRepoFixture(name: string): { repo: LogicalRepository; otherPath: string } {
    const canonicalPath = makeRepo();
    const recordedBaseOid = commitFile(canonicalPath, "seed.txt", "seed");
    git(canonicalPath, "update-ref", "refs/heads/base", recordedBaseOid);
    const targetOid = commitFile(canonicalPath, "update.txt", "update");

    const otherPath = makeRepo();
    git(otherPath, "fetch", canonicalPath, "refs/heads/base:refs/heads/base");

    return {
        otherPath,
        repo: {
            name,
            canonicalOccurrencePath: canonicalPath,
            canonicalRefName: "refs/heads/base",
            otherOccurrences: [{ path: otherPath, refName: "refs/heads/base" }],
            recordedBaseOid,
            targetOid,
        },
    };
}

test("test_nothingPublishesBeforeRootIntegrationOidExists", () => {
    const { repo } = makeLogicalRepoFixture("repo-a");
    const rootIntegration = makeRootIntegration(false);

    const result = publishBases([repo], approvedRunState(), rootIntegration);

    assert.equal(result.published, false);
    assert.equal(result.rollback.length, 0);
    assert.equal(git(repo.canonicalOccurrencePath, "rev-parse", repo.canonicalRefName), repo.recordedBaseOid);
});

test("test_baseRefMovedSinceApprovalBlocksPublicationEntirely", () => {
    const fixtureA = makeLogicalRepoFixture("repo-a");
    const fixtureB = makeLogicalRepoFixture("repo-b");
    const rootIntegration = makeRootIntegration(true);

    // Simulate a concurrent mover advancing repo A's canonical ref before publication runs.
    git(fixtureA.repo.canonicalOccurrencePath, "update-ref", "refs/heads/base", fixtureA.repo.targetOid);

    const result = publishBases([fixtureA.repo, fixtureB.repo], approvedRunState(), rootIntegration);

    assert.equal(result.published, false);
    assert.equal(result.rollback.length, 0);
    assert.equal(
        git(fixtureB.repo.canonicalOccurrencePath, "rev-parse", fixtureB.repo.canonicalRefName),
        fixtureB.repo.recordedBaseOid,
    );
});

test("test_compareAndSwapPreventsClobberingConcurrentUpdate", () => {
    const { repo } = makeLogicalRepoFixture("repo-a");
    const concurrentOid = commitFile(repo.canonicalOccurrencePath, "concurrent.txt", "concurrent");
    // A concurrent mover sets the canonical ref to concurrentOid; repo.recordedBaseOid is now stale.
    git(repo.canonicalOccurrencePath, "update-ref", repo.canonicalRefName, concurrentOid);

    const result = publishCanonicalRef(repo);

    assert.equal(result.ok, false);
    assert.equal(git(repo.canonicalOccurrencePath, "rev-parse", repo.canonicalRefName), concurrentOid);
});

test("test_midSequenceFailureRollsBackEveryAlreadyUpdatedRefToRecordedOid", () => {
    const fixtureA = makeLogicalRepoFixture("repo-a");
    const fixtureB = makeLogicalRepoFixture("repo-b");
    const fixtureC = makeLogicalRepoFixture("repo-c");
    const rootIntegration = makeRootIntegration(true);

    // Force repo C's canonical CAS to fail without tripping pass-1: recordedBaseOid still matches, but targetOid is nonexistent.
    const failingRepoC: LogicalRepository = { ...fixtureC.repo, targetOid: "a".repeat(40) };

    const result = publishBases([fixtureA.repo, fixtureB.repo, failingRepoC], approvedRunState(), rootIntegration);

    assert.equal(result.published, false);
    for (const fixture of [fixtureA, fixtureB]) {
        assert.equal(
            git(fixture.repo.canonicalOccurrencePath, "rev-parse", fixture.repo.canonicalRefName),
            fixture.repo.recordedBaseOid,
        );
        assert.equal(git(fixture.otherPath, "rev-parse", fixture.repo.otherOccurrences[0].refName), fixture.repo.recordedBaseOid);
    }
});

test("test_failingRollbackPreservesIntegrationAndRecoveryRefsAndReportsExactCommandPerRepository", () => {
    const fixtureA = makeLogicalRepoFixture("repo-a");
    const fixtureB = makeLogicalRepoFixture("repo-b");

    const integrationRepo = makeRepo();
    const integrationRef = "refs/finalize/run-9/tip/root";
    git(integrationRepo, "update-ref", integrationRef, commitFile(integrationRepo, "root.txt", "root"));
    const recoveryRef = "refs/recovery/run-9/worker/w1";
    git(integrationRepo, "update-ref", recoveryRef, git(integrationRepo, "rev-parse", "HEAD"));
    const integrationOidBefore = git(integrationRepo, "rev-parse", integrationRef);
    const recoveryOidBefore = git(integrationRepo, "rev-parse", recoveryRef);

    // Simulate what a successful pass-2 would have collected for repos A and B.
    const updatedSoFar: UpdatedRef[] = [];
    for (const fixture of [fixtureA, fixtureB]) {
        const canonicalResult = publishCanonicalRef(fixture.repo);
        assert.equal(canonicalResult.ok, true);
        updatedSoFar.push(canonicalResult.updated!);
        git(
            fixture.otherPath,
            "fetch",
            fixture.repo.canonicalOccurrencePath,
            `${fixture.repo.canonicalRefName}:${fixture.repo.otherOccurrences[0].refName}`,
        );
        updatedSoFar.push({
            repoName: fixture.repo.name,
            occurrencePath: fixture.otherPath,
            refName: fixture.repo.otherOccurrences[0].refName,
            recordedOid: fixture.repo.recordedBaseOid,
            newOid: fixture.repo.targetOid,
        });
    }

    // A concurrent actor moves repo A's canonical ref again, after publish but before rollback.
    const concurrentOid = commitFile(fixtureA.repo.canonicalOccurrencePath, "concurrent.txt", "concurrent");
    git(fixtureA.repo.canonicalOccurrencePath, "update-ref", fixtureA.repo.canonicalRefName, concurrentOid);

    const outcomes = rollbackUpdatedRefs(updatedSoFar);

    const repoAOutcome = outcomes.find(
        (outcome) => outcome.ref.repoName === "repo-a" && outcome.ref.occurrencePath === fixtureA.repo.canonicalOccurrencePath,
    )!;
    const repoBOutcome = outcomes.find(
        (outcome) => outcome.ref.repoName === "repo-b" && outcome.ref.occurrencePath === fixtureB.repo.canonicalOccurrencePath,
    )!;

    assert.equal(repoBOutcome.rolledBack, true);
    assert.equal(repoAOutcome.rolledBack, false);
    assert.equal(
        repoAOutcome.recoveryCommand,
        `git -C ${fixtureA.repo.canonicalOccurrencePath} update-ref ${fixtureA.repo.canonicalRefName} ${fixtureA.repo.recordedBaseOid}`,
    );
    assert.equal(git(integrationRepo, "rev-parse", integrationRef), integrationOidBefore);
    assert.equal(git(integrationRepo, "rev-parse", recoveryRef), recoveryOidBefore);
});

test("test_otherOccurrencesFastForwardLocallyWithoutRemotePush", () => {
    const { repo, otherPath } = makeLogicalRepoFixture("repo-a");
    const rootIntegration = makeRootIntegration(true);

    const result = publishBases([repo], approvedRunState(), rootIntegration);

    assert.equal(result.published, true);
    assert.equal(git(otherPath, "rev-parse", repo.otherOccurrences[0].refName), repo.targetOid);
    assert.equal(git(otherPath, "remote"), "");
});

```

### tests/logicalRepository.test.ts

```
// Behavioral checks for logicalRepository.ts: grouping occurrences by shared upstream identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLogicalRepositories } from "../scripts/logicalRepository.ts";
import type { RepositoryOccurrence } from "../scripts/repositoryManifest.ts";

function makeOccurrence(id: string, parentId: string | null, path: string, rawUrl: string): RepositoryOccurrence {
    return {
        occurrenceId: id,
        checkoutPath: path,
        parentOccurrenceId: parentId,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: rawUrl,
        baseBranch: "main",
        baseOid: "0".repeat(40),
        operationBranch: "",
        childOccurrenceIds: [],
        testState: "untested",
    };
}

const TMUX_LIB_URL = "https://example.com/group/tmux_lib.git";
const CLAUDE_PLUGIN_LIB_URL = "https://example.com/group/claude_plugin_lib.git";
const SCENARIOS_URL = "https://example.com/group/scenarios.git";
const ONLY_ONE_LIB_URL = "https://example.com/group/only_one_lib.git";

function buildMultiRepoFixture(): RepositoryOccurrence[] {
    return [
        makeOccurrence("tmux1", null, "tmux_lib", TMUX_LIB_URL),
        makeOccurrence("tmux2", "jfred", "jfred/external/tmux_lib", TMUX_LIB_URL),
        makeOccurrence(
            "tmux3",
            "jfredToolsPlugin",
            "jfred/jfredToolsPlugin/external/tmux_lib",
            TMUX_LIB_URL,
        ),
        makeOccurrence("plugin1", "jfred", "jfred/claude_plugin_lib", CLAUDE_PLUGIN_LIB_URL),
        makeOccurrence("plugin2", "other", "other/claude_plugin_lib", CLAUDE_PLUGIN_LIB_URL),
        makeOccurrence("scenarios1", "jfred", "jfred/scenarios", SCENARIOS_URL),
        makeOccurrence("scenarios2", "other", "other/scenarios", SCENARIOS_URL),
        makeOccurrence("only1", null, "only_one_lib", ONLY_ONE_LIB_URL),
    ];
}

test("test_groupsThreeOccurrencesOfSameUpstreamIntoOneLogicalRepository", () => {
    const logicalRepositories = buildLogicalRepositories(buildMultiRepoFixture());
    const tmuxGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("tmux1"));
    assert.ok(tmuxGroup);
    assert.equal(tmuxGroup.occurrenceIds.length, 3);
    assert.deepEqual(new Set(tmuxGroup.occurrenceIds), new Set(["tmux1", "tmux2", "tmux3"]));
});

test("test_preservesEachOccurrencesParentEdgeAndPath", () => {
    const fixture = buildMultiRepoFixture();
    const snapshot = fixture.map((occurrence) => ({ ...occurrence }));
    buildLogicalRepositories(fixture);
    fixture.forEach((occurrence, index) => {
        assert.equal(occurrence.occurrenceId, snapshot[index].occurrenceId);
        assert.equal(occurrence.parentOccurrenceId, snapshot[index].parentOccurrenceId);
        assert.equal(occurrence.checkoutPath, snapshot[index].checkoutPath);
    });
});

test("test_groupsTwoOccurrencesOfClaudePluginLibIntoOwnTwoMemberClass", () => {
    const logicalRepositories = buildLogicalRepositories(buildMultiRepoFixture());
    const pluginGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("plugin1"));
    const tmuxGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("tmux1"));
    const scenariosGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("scenarios1"));
    assert.ok(pluginGroup);
    assert.equal(pluginGroup.occurrenceIds.length, 2);
    assert.deepEqual(new Set(pluginGroup.occurrenceIds), new Set(["plugin1", "plugin2"]));
    assert.notEqual(pluginGroup, tmuxGroup);
    assert.notEqual(pluginGroup, scenariosGroup);
});

test("test_groupsTwoOccurrencesOfScenariosIntoOwnTwoMemberClass", () => {
    const logicalRepositories = buildLogicalRepositories(buildMultiRepoFixture());
    const scenariosGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("scenarios1"));
    assert.ok(scenariosGroup);
    assert.equal(scenariosGroup.occurrenceIds.length, 2);
    assert.deepEqual(new Set(scenariosGroup.occurrenceIds), new Set(["scenarios1", "scenarios2"]));
});

test("test_formsOneMemberClassForUniqueRepository", () => {
    const logicalRepositories = buildLogicalRepositories(buildMultiRepoFixture());
    const onlyOneGroup = logicalRepositories.find((repo) => repo.occurrenceIds.includes("only1"));
    assert.ok(onlyOneGroup);
    assert.equal(onlyOneGroup.occurrenceIds.length, 1);
    assert.equal(onlyOneGroup.consolidationState, "single");
});

test("test_supportsFourOrMoreOccurrencesOfOneLogicalRepository", () => {
    const fiveOccurrences = Array.from({ length: 5 }, (_, index) =>
        makeOccurrence(`shared${index}`, null, `path${index}`, TMUX_LIB_URL),
    );
    const logicalRepositories = buildLogicalRepositories(fiveOccurrences);
    assert.equal(logicalRepositories.length, 1);
    assert.equal(logicalRepositories[0].occurrenceIds.length, 5);
    assert.deepEqual(
        new Set(logicalRepositories[0].occurrenceIds),
        new Set(["shared0", "shared1", "shared2", "shared3", "shared4"]),
    );
});

test("test_overlayNeverDropsMergesOrReparentsAnyOccurrenceAcrossFullFixture", () => {
    const fixture = buildMultiRepoFixture();
    const logicalRepositories = buildLogicalRepositories(fixture);
    const flattenedIds = logicalRepositories.flatMap((repo) => repo.occurrenceIds);
    assert.deepEqual(new Set(flattenedIds), new Set(fixture.map((occurrence) => occurrence.occurrenceId)));
    assert.equal(logicalRepositories.length, 4);
    assert.equal(flattenedIds.length, new Set(flattenedIds).size);
});

test("test_eachLogicalRepositoryIncludesRequiredRecordFields", () => {
    const fixture = [
        makeOccurrence("a1", null, "a", ONLY_ONE_LIB_URL),
        makeOccurrence("a2", "a1", "a/nested", ONLY_ONE_LIB_URL),
    ];
    const [logicalRepository] = buildLogicalRepositories(fixture);
    assert.ok(logicalRepository.normalizedIdentity);
    assert.deepEqual(logicalRepository.occurrenceIds, ["a1", "a2"]);
    assert.ok(logicalRepository.occurrenceIds.includes(logicalRepository.selectedBaseOccurrenceId));
    assert.ok(logicalRepository.occurrenceIds.includes(logicalRepository.canonicalOccurrenceId));
    assert.equal(typeof logicalRepository.convergenceDigest, "string");
    assert.equal(logicalRepository.consolidationState, "grouped");
});

```

### tests/operationPush.test.ts

```
// Behavioral checks for operationPush.ts: canonical-only push, no force, ancestor gate, verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogicalRepository } from "../scripts/logicalRepository.ts";
import type { RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import { issueRunAuthorization } from "../scripts/runAuthorization.ts";
import {
    NonAncestorRemoteTipError,
    OccurrenceVerificationMismatchError,
    RunNotApprovedError,
    buildPushArgv,
    pushOperationBranches,
} from "../scripts/operationPush.ts";

const AUTH_DIGEST = "digest-a";
const token = issueRunAuthorization(AUTH_DIGEST);

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempGitRepo(prefix: string): string {
    const repoPath = mkdtempSync(join(tmpdir(), prefix));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    return repoPath;
}

function makeBareGitRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "operation-push-remote-"));
    git(repoPath, "init", "-q", "--bare", "-b", "main");
    return repoPath;
}

function commit(repoPath: string, fileName: string): string {
    writeFileSync(join(repoPath, fileName), `${fileName}\n`);
    git(repoPath, "add", fileName);
    git(repoPath, "commit", "-q", "-m", fileName);
    return git(repoPath, "rev-parse", "HEAD");
}

function makeOccurrence(overrides: Partial<RepositoryOccurrence>): RepositoryOccurrence {
    return {
        occurrenceId: "root",
        checkoutPath: "",
        parentOccurrenceId: null,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: "",
        baseBranch: "main",
        baseOid: "0".repeat(40),
        operationBranch: "op-branch",
        childOccurrenceIds: [],
        testState: "untested",
        ...overrides,
    };
}

function makeLogicalRepository(overrides: Partial<LogicalRepository>): LogicalRepository {
    return {
        normalizedIdentity: { host: "example.com", owner: "acme", repository: "widgets" },
        occurrenceIds: ["root"],
        selectedBaseOccurrenceId: "root",
        canonicalOccurrenceId: "root",
        lastWriterOccurrenceId: "root",
        convergenceDigest: "digest",
        consolidationState: "single",
        ...overrides,
    };
}

test("test_uniqueRepositoryOperationBranchIsNotPushed", async () => {
    const bareRemote = makeBareGitRepo();
    const repoPath = makeTempGitRepo("operation-push-unique-");
    commit(repoPath, "a.txt");
    git(repoPath, "branch", "op-branch");
    const occurrence = makeOccurrence({ checkoutPath: repoPath, originUrl: bareRemote });
    const logicalRepository = makeLogicalRepository({ occurrenceIds: ["root"], canonicalOccurrenceId: "root" });

    const results = await pushOperationBranches(
        { logicalRepositories: [logicalRepository], occurrences: [occurrence] },
        token,
        AUTH_DIGEST,
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].kind, "skipped-unique");
    assert.equal(git(bareRemote, "for-each-ref", "refs/heads/op-branch"), "");
});

test("test_repeatedRepositoryPushesOnlyCanonicalBranch", async () => {
    const bareRemote = makeBareGitRepo();
    const canonicalPath = makeTempGitRepo("operation-push-canonical-");
    const oid = commit(canonicalPath, "a.txt");
    git(canonicalPath, "branch", "op-branch");
    const otherPath = makeTempGitRepo("operation-push-other-");
    git(otherPath, "fetch", canonicalPath, "main");
    git(otherPath, "branch", "op-branch", "FETCH_HEAD");

    const canonicalOccurrence = makeOccurrence({ occurrenceId: "canonical", checkoutPath: canonicalPath, originUrl: bareRemote });
    const otherOccurrence = makeOccurrence({ occurrenceId: "other", checkoutPath: otherPath, originUrl: bareRemote });
    const logicalRepository = makeLogicalRepository({ occurrenceIds: ["canonical", "other"], canonicalOccurrenceId: "canonical", consolidationState: "grouped" });

    const results = await pushOperationBranches(
        { logicalRepositories: [logicalRepository], occurrences: [canonicalOccurrence, otherOccurrence] },
        token,
        AUTH_DIGEST,
    );

    assert.equal(results.length, 1);
    assert.deepEqual(results[0], { kind: "pushed", convergenceDigest: logicalRepository.convergenceDigest, oid });
    assert.equal(git(bareRemote, "for-each-ref", "refs/heads/op-branch").split("\n").length, 1);
    assert.equal(git(bareRemote, "rev-parse", "refs/heads/op-branch"), oid);
});

test("test_nonAncestorRemoteTipAbortsBeforePublication", async () => {
    const bareRemote = makeBareGitRepo();
    const canonicalPath = makeTempGitRepo("operation-push-divergent-");
    const oid = commit(canonicalPath, "a.txt");
    git(canonicalPath, "branch", "op-branch");

    const divergentSource = makeTempGitRepo("operation-push-divergent-source-");
    const divergentOid = commit(divergentSource, "b.txt");
    git(bareRemote, "fetch", divergentSource, `main:refs/heads/op-branch`);
    assert.equal(git(bareRemote, "rev-parse", "refs/heads/op-branch"), divergentOid);

    const occurrence = makeOccurrence({ occurrenceId: "canonical", checkoutPath: canonicalPath, originUrl: bareRemote });
    const logicalRepository = makeLogicalRepository({ occurrenceIds: ["canonical", "other"], canonicalOccurrenceId: "canonical", consolidationState: "grouped" });
    const otherOccurrence = makeOccurrence({ occurrenceId: "other", checkoutPath: divergentSource, originUrl: bareRemote });

    await assert.rejects(
        () =>
            pushOperationBranches(
                { logicalRepositories: [logicalRepository], occurrences: [occurrence, otherOccurrence] },
                token,
                AUTH_DIGEST,
            ),
        NonAncestorRemoteTipError,
    );
    assert.equal(git(bareRemote, "rev-parse", "refs/heads/op-branch"), divergentOid);
    assert.notEqual(oid, divergentOid);
});

test("test_noPushUsesForceUnderAnyPath", () => {
    const argv = buildPushArgv("origin", "a".repeat(40), "tackle-op/run1/root");
    assert.deepEqual(argv, ["push", "origin", `${"a".repeat(40)}:refs/heads/tackle-op/run1/root`]);
    assert.equal(argv.includes("-f"), false);
    assert.equal(argv.includes("--force"), false);
});

test("test_afterPushEveryOtherOccurrenceVerifiesSameOidAndTree", async () => {
    const bareRemote = makeBareGitRepo();
    const canonicalPath = makeTempGitRepo("operation-push-verify-canonical-");
    const oid = commit(canonicalPath, "a.txt");
    git(canonicalPath, "branch", "op-branch");
    const otherPath = makeTempGitRepo("operation-push-verify-other-");
    git(otherPath, "fetch", canonicalPath, "main");
    git(otherPath, "branch", "op-branch", "FETCH_HEAD");

    const canonicalOccurrence = makeOccurrence({ occurrenceId: "canonical", checkoutPath: canonicalPath, originUrl: bareRemote });
    const otherOccurrence = makeOccurrence({ occurrenceId: "other", checkoutPath: otherPath, originUrl: bareRemote });
    const logicalRepository = makeLogicalRepository({ occurrenceIds: ["canonical", "other"], canonicalOccurrenceId: "canonical", consolidationState: "grouped" });

    await pushOperationBranches(
        { logicalRepositories: [logicalRepository], occurrences: [canonicalOccurrence, otherOccurrence] },
        token,
        AUTH_DIGEST,
    );

    const canonicalTree = git(canonicalPath, "rev-parse", `${oid}^{tree}`);
    assert.equal(git(otherPath, "rev-parse", "FETCH_HEAD"), oid);
    assert.equal(git(otherPath, "rev-parse", "FETCH_HEAD^{tree}"), canonicalTree);
});

test("test_pushAttemptedBeforeApprovalFails", async () => {
    const bareRemote = makeBareGitRepo();
    const canonicalPath = makeTempGitRepo("operation-push-unapproved-");
    commit(canonicalPath, "a.txt");
    git(canonicalPath, "branch", "op-branch");
    const otherPath = makeTempGitRepo("operation-push-unapproved-other-");

    const canonicalOccurrence = makeOccurrence({ occurrenceId: "canonical", checkoutPath: canonicalPath, originUrl: bareRemote });
    const otherOccurrence = makeOccurrence({ occurrenceId: "other", checkoutPath: otherPath, originUrl: bareRemote });
    const logicalRepository = makeLogicalRepository({ occurrenceIds: ["canonical", "other"], canonicalOccurrenceId: "canonical", consolidationState: "grouped" });

    await assert.rejects(
        () =>
            pushOperationBranches(
                { logicalRepositories: [logicalRepository], occurrences: [canonicalOccurrence, otherOccurrence] },
                token,
                "wrong-digest",
            ),
        RunNotApprovedError,
    );
    assert.equal(git(bareRemote, "for-each-ref", "refs/heads/op-branch"), "");
});

```

### tests/runConsolidation.test.ts

```
// Behavioral checks for runConsolidation.ts. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    consolidateLogicalRepository,
    consolidateRun,
} from "../scripts/runConsolidation.ts";
import type { GroupOccurrenceBranch, LogicalRepositoryConsolidationInput } from "../scripts/runConsolidation.ts";
import { issueRunAuthorization } from "../scripts/runAuthorization.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "run-consolidation-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

// Builds a repo with a base commit and two branches (groupA/repo, groupB/repo) editing disjoint files.
function makeDisjointTwoGroupFixture(): {
    repoRoot: string;
    baseOid: string;
    groupA: GroupOccurrenceBranch;
    groupB: GroupOccurrenceBranch;
    convergedTreeOid: string;
} {
    const repoRoot = makeTempRepoWithCommit();
    const baseOid = git(repoRoot, "rev-parse", "HEAD");

    git(repoRoot, "checkout", "-q", "-b", "groupA/repo");
    writeFileSync(join(repoRoot, "a.txt"), "a\n");
    git(repoRoot, "add", "a.txt");
    git(repoRoot, "commit", "-q", "-m", "add a.txt");
    const groupABranchOid = git(repoRoot, "rev-parse", "HEAD");

    git(repoRoot, "checkout", "-q", baseOid);
    git(repoRoot, "checkout", "-q", "-b", "groupB/repo");
    writeFileSync(join(repoRoot, "b.txt"), "b\n");
    git(repoRoot, "add", "b.txt");
    git(repoRoot, "commit", "-q", "-m", "add b.txt");
    const groupBBranchOid = git(repoRoot, "rev-parse", "HEAD");

    const convergedTreeOid = git(repoRoot, "merge-tree", "--write-tree", groupABranchOid, groupBBranchOid);

    git(repoRoot, "checkout", "-q", "master");

    const groupA: GroupOccurrenceBranch = {
        groupId: "groupA",
        occurrencePath: "repo",
        occurrenceId: "occ-a",
        branchOid: groupABranchOid,
        sourceRepoRoot: repoRoot,
    };
    const groupB: GroupOccurrenceBranch = {
        groupId: "groupB",
        occurrencePath: "repo",
        occurrenceId: "occ-b",
        branchOid: groupBBranchOid,
        sourceRepoRoot: repoRoot,
    };
    return { repoRoot, baseOid, groupA, groupB, convergedTreeOid };
}

function makeInput(
    fixture: ReturnType<typeof makeDisjointTwoGroupFixture>,
    overrides: Partial<LogicalRepositoryConsolidationInput> = {},
): LogicalRepositoryConsolidationInput {
    return {
        logicalRepositoryId: "logical-repo-1",
        canonicalRepoRoot: fixture.repoRoot,
        canonicalOccurrenceBranchName: "groupB/repo",
        participatingBranches: [fixture.groupA, fixture.groupB],
        approvedConvergedTreeOid: fixture.convergedTreeOid,
        finalizedChildGitlinks: [],
        recordedBaseOid: fixture.baseOid,
        baseBranchRef: "refs/heads/master",
        ...overrides,
    };
}

test("test_twoDisjointGroupsBecomeAncestorsOfOneOperationBranch", () => {
    const fixture = makeDisjointTwoGroupFixture();
    const input = makeInput(fixture);
    const result = consolidateLogicalRepository(input, "run-1");
    assert.equal("aborted" in result, false);
    if ("aborted" in result) return;
    assert.doesNotThrow(() =>
        git(fixture.repoRoot, "merge-base", "--is-ancestor", fixture.groupA.branchOid, result.operationOid),
    );
    assert.doesNotThrow(() =>
        git(fixture.repoRoot, "merge-base", "--is-ancestor", fixture.groupB.branchOid, result.operationOid),
    );
});

test("test_mergeOrderIsDeterministic", () => {
    const fixture = makeDisjointTwoGroupFixture();
    const inputForward = makeInput(fixture, {
        participatingBranches: [fixture.groupA, fixture.groupB],
    });
    const inputReversed = makeInput(fixture, {
        participatingBranches: [fixture.groupB, fixture.groupA],
    });
    const resultForward = consolidateLogicalRepository(inputForward, "run-2");
    // Forward call fast-forwarded the occurrence branches; reset them before the reversed call.
    git(fixture.repoRoot, "update-ref", "refs/heads/groupA/repo", fixture.groupA.branchOid);
    git(fixture.repoRoot, "update-ref", "refs/heads/groupB/repo", fixture.groupB.branchOid);
    const resultReversed = consolidateLogicalRepository(inputReversed, "run-2");
    if ("aborted" in resultForward || "aborted" in resultReversed) {
        assert.fail("expected both calls to succeed");
        return;
    }
    assert.equal(resultForward.operationOid, resultReversed.operationOid);
});

test("test_treeMismatchAbortsWithEveryRefPreserved", () => {
    const fixture = makeDisjointTwoGroupFixture();
    const wrongTreeOid = git(fixture.repoRoot, "rev-parse", `${fixture.baseOid}^{tree}`);
    const input = makeInput(fixture, { approvedConvergedTreeOid: wrongTreeOid });
    const result = consolidateLogicalRepository(input, "run-3");
    assert.ok("aborted" in result);
    if (!("aborted" in result)) return;
    assert.equal(result.aborted.reason, "tree-mismatch");
    assert.equal("conflicts" in result.aborted, false);
    const operationBranchRef = `refs/heads/operations/run-3/${input.canonicalOccurrenceBranchName}`;
    assert.throws(() => git(fixture.repoRoot, "show-ref", "--verify", operationBranchRef));
    assert.equal(git(fixture.repoRoot, "rev-parse", "refs/heads/groupA/repo"), fixture.groupA.branchOid);
    assert.equal(git(fixture.repoRoot, "rev-parse", "refs/heads/groupB/repo"), fixture.groupB.branchOid);
});

// Builds a repo with two branches editing the same line of the same file differently, so folding conflicts.
function makeConflictingTwoGroupFixture(): {
    repoRoot: string;
    baseOid: string;
    groupA: GroupOccurrenceBranch;
    groupB: GroupOccurrenceBranch;
} {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "shared.txt"), "line1\nline2\nline3\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");
    const baseOid = git(repoRoot, "rev-parse", "HEAD");

    git(repoRoot, "checkout", "-q", "-b", "groupA/repo");
    writeFileSync(join(repoRoot, "shared.txt"), "line1\nline2-a\nline3\n");
    git(repoRoot, "commit", "-q", "-am", "groupA change");
    const groupABranchOid = git(repoRoot, "rev-parse", "HEAD");

    git(repoRoot, "checkout", "-q", baseOid);
    git(repoRoot, "checkout", "-q", "-b", "groupB/repo");
    writeFileSync(join(repoRoot, "shared.txt"), "line1\nline2-b\nline3\n");
    git(repoRoot, "commit", "-q", "-am", "groupB change");
    const groupBBranchOid = git(repoRoot, "rev-parse", "HEAD");

    git(repoRoot, "checkout", "-q", "master");

    const groupA: GroupOccurrenceBranch = {
        groupId: "groupA",
        occurrencePath: "repo",
        occurrenceId: "occ-a",
        branchOid: groupABranchOid,
        sourceRepoRoot: repoRoot,
    };
    const groupB: GroupOccurrenceBranch = {
        groupId: "groupB",
        occurrencePath: "repo",
        occurrenceId: "occ-b",
        branchOid: groupBBranchOid,
        sourceRepoRoot: repoRoot,
    };
    return { repoRoot, baseOid, groupA, groupB };
}

test("test_conflictReturnsRepositoryQualifiedResultsAndLeavesBaseRefsUntouched", () => {
    const fixture = makeConflictingTwoGroupFixture();
    const input: LogicalRepositoryConsolidationInput = {
        logicalRepositoryId: "logical-repo-conflict",
        canonicalRepoRoot: fixture.repoRoot,
        canonicalOccurrenceBranchName: "groupB/repo",
        participatingBranches: [fixture.groupA, fixture.groupB],
        approvedConvergedTreeOid: "0".repeat(40),
        finalizedChildGitlinks: [],
        recordedBaseOid: fixture.baseOid,
        baseBranchRef: "refs/heads/master",
    };
    const result = consolidateLogicalRepository(input, "run-4");
    assert.ok("aborted" in result);
    if (!("aborted" in result)) return;
    assert.equal(result.aborted.reason, "conflict");
    assert.ok(result.aborted.conflicts && result.aborted.conflicts.length > 0);
    assert.ok((result.aborted.conflicts?.[0].conflictedPaths.length ?? 0) > 0);
    assert.equal(git(fixture.repoRoot, "rev-parse", "refs/heads/master"), input.recordedBaseOid);
    const operationBranchRef = `refs/heads/operations/run-4/${input.canonicalOccurrenceBranchName}`;
    assert.throws(() => git(fixture.repoRoot, "show-ref", "--verify", operationBranchRef));
});

test("test_exactlyOnePreparedIntegrationOidPerLogicalRepository", () => {
    const fixtureOne = makeDisjointTwoGroupFixture();
    const fixtureTwo = makeDisjointTwoGroupFixture();
    const inputOne = makeInput(fixtureOne, { logicalRepositoryId: "logical-repo-one" });
    const inputTwo = makeInput(fixtureTwo, { logicalRepositoryId: "logical-repo-two" });
    const token = issueRunAuthorization("digest-abc");
    const results = consolidateRun("run-5", [inputOne, inputTwo], token, "digest-abc");
    assert.equal(results.length, 2);
    for (const result of results) {
        assert.equal("aborted" in result, false);
        if ("aborted" in result) return;
        assert.equal(typeof result.preparedIntegrationOid, "string");
    }
    const [resultOne, resultTwo] = results;
    if ("aborted" in resultOne || "aborted" in resultTwo) return;
    assert.notEqual(resultOne.preparedIntegrationOid, resultTwo.preparedIntegrationOid);
});

```

### tests/testPolicy.test.ts

```
// Behavioral checks for testPolicy.ts: per-occurrence test command discovery. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    discoverTestPolicy,
    REASON_NO_TEST_CONFIGURATION,
    REASON_AMBIGUOUS_RELATED_TEST_COMMAND,
} from "../scripts/testPolicy.ts";
import { createEmptyResolutionManifest } from "../scripts/resolutionRequests.ts";

function withTempDir(body: (dirPath: string) => void): void {
    const dirPath = mkdtempSync(join(tmpdir(), "test-policy-"));
    try {
        body(dirPath);
    } finally {
        rmSync(dirPath, { recursive: true, force: true });
    }
}

function writePackageJson(dirPath: string, scripts: Record<string, string>): void {
    writeFileSync(join(dirPath, "package.json"), JSON.stringify({ scripts }));
}

test("test_missingPackageJsonProducesResolutionRequest", () => {
    withTempDir((dirPath) => {
        const manifest = createEmptyResolutionManifest();
        const result = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(result.status, "needsResolution");
        if (result.status !== "needsResolution") return;
        assert.equal(result.resolutionRequests.length, 1);
        assert.equal(result.resolutionRequests[0].reason, REASON_NO_TEST_CONFIGURATION);
        assert.deepEqual(result.resolutionRequests[0].candidateBaseBranches, []);
    });
});

test("test_packageJsonWithoutTestScriptProducesResolutionRequest", () => {
    withTempDir((dirPath) => {
        writePackageJson(dirPath, { build: "tsc" });
        const manifest = createEmptyResolutionManifest();
        const result = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(result.status, "needsResolution");
        if (result.status !== "needsResolution") return;
        assert.equal(result.resolutionRequests.length, 1);
        assert.equal(result.resolutionRequests[0].reason, REASON_NO_TEST_CONFIGURATION);
        assert.deepEqual(result.resolutionRequests[0].candidateBaseBranches, []);
    });
});

test("test_unambiguousTestScriptIsDiscoveredAndRecorded", () => {
    withTempDir((dirPath) => {
        writePackageJson(dirPath, { test: "vitest run" });
        const manifest = createEmptyResolutionManifest();
        const result = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(result.status, "resolved");
        if (result.status !== "resolved") return;
        assert.equal(result.policy.occurrenceId, "occ-1");
        assert.equal(result.policy.completeSuiteCommand, "npm run test");
        assert.equal(result.policy.relatedTestCommand, result.policy.completeSuiteCommand);
    });
});

test("test_unambiguousRelatedScriptIsRecordedSeparatelyFromCompleteSuite", () => {
    withTempDir((dirPath) => {
        writePackageJson(dirPath, { test: "vitest run", "test:related": "vitest related" });
        const manifest = createEmptyResolutionManifest();
        const result = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(result.status, "resolved");
        if (result.status !== "resolved") return;
        assert.equal(result.policy.completeSuiteCommand, "npm run test");
        assert.equal(result.policy.relatedTestCommand, "npm run test:related");
    });
});

test("test_twoEquallyPlausibleRelatedCandidatesProduceResolutionRequest", () => {
    withTempDir((dirPath) => {
        writeFileSync(
            join(dirPath, "package.json"),
            JSON.stringify({ scripts: { test: "x", "test:changed": "b", "test:related": "a" } })
        );
        const manifest = createEmptyResolutionManifest();
        const result = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(result.status, "needsResolution");
        if (result.status !== "needsResolution") return;
        assert.equal(result.resolutionRequests.length, 1);
        assert.equal(result.resolutionRequests[0].reason, REASON_AMBIGUOUS_RELATED_TEST_COMMAND);
        assert.deepEqual(result.resolutionRequests[0].candidateBaseBranches, ["test:related", "test:changed"]);
    });
});

test("test_persistedAnswerIsReusedOnNextRunForAmbiguousCandidates", () => {
    withTempDir((dirPath) => {
        writePackageJson(dirPath, { test: "x", "test:related": "a", "test:changed": "b" });
        const manifest = createEmptyResolutionManifest();
        const firstResult = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(firstResult.status, "needsResolution");
        if (firstResult.status !== "needsResolution") return;
        const requestId = firstResult.resolutionRequests[0].id;
        manifest.resolutionAnswers[requestId] = "test:changed";

        const secondResult = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(secondResult.status, "resolved");
        if (secondResult.status !== "resolved") return;
        assert.equal(secondResult.policy.relatedTestCommand, "npm run test:changed");
        assert.equal(secondResult.policy.completeSuiteCommand, "npm run test");
    });
});

test("test_persistedAnswerIsReusedOnNextRunForMissingConfiguration", () => {
    withTempDir((dirPath) => {
        const manifest = createEmptyResolutionManifest();
        const firstResult = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(firstResult.status, "needsResolution");
        if (firstResult.status !== "needsResolution") return;
        const requestId = firstResult.resolutionRequests[0].id;
        manifest.resolutionAnswers[requestId] = "npm run custom-test";

        const secondResult = discoverTestPolicy("occ-1", dirPath, manifest);
        assert.equal(secondResult.status, "resolved");
        if (secondResult.status !== "resolved") return;
        assert.equal(secondResult.policy.relatedTestCommand, "npm run custom-test");
        assert.equal(secondResult.policy.completeSuiteCommand, "npm run custom-test");
    });
});

test("test_occurrencesOfOneLogicalRepositoryCarrySamePolicyWhileRecordedSeparately", () => {
    withTempDir((dirPath) => {
        writePackageJson(dirPath, { test: "vitest run" });
        const manifest = createEmptyResolutionManifest();
        const resultA = discoverTestPolicy("occ-a", dirPath, manifest);
        const resultB = discoverTestPolicy("occ-b", dirPath, manifest);
        assert.equal(resultA.status, "resolved");
        assert.equal(resultB.status, "resolved");
        if (resultA.status !== "resolved" || resultB.status !== "resolved") return;
        assert.notEqual(resultA.policy.occurrenceId, resultB.policy.occurrenceId);
        assert.equal(resultA.policy.relatedTestCommand, resultB.policy.relatedTestCommand);
        assert.equal(resultA.policy.completeSuiteCommand, resultB.policy.completeSuiteCommand);
    });
});

```
