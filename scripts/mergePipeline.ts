// Translates the CLI's flat merge input into the finalize/consolidate/push/publish/archive pipeline.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath, type WorkflowArguments } from "./prepareTasks.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";
import { computeOccurrenceDigests, recordApproval, issueApprovalAuthorization, finalizeApprovedRun, computeApprovalDigest, type OccurrenceSnapshot, type RunState, type ApprovalDigestInput } from "./approvalGate.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import { validateRepositoryManifest, type RepositoryManifest, type RepositoryOccurrence } from "./repositoryManifest.ts";
import { normalizeRepositoryIdentity, type RepositoryIdentity } from "./submoduleUrlIdentity.ts";
import type { LogicalRepository } from "./logicalRepository.ts";
import { prepareNoFfMerge } from "./repositoryIntegration.ts";
import { consolidateRun, type GroupOccurrenceBranch, type LogicalRepositoryConsolidationInput } from "./runConsolidation.ts";
import { pushOperationBranches, type OperationPushInput } from "./operationPush.ts";
import { publishBases, readCurrentRefOid, type PublicationTarget } from "./basePublication.ts";
import { summarizeTaskMergeResults, archivePublishedTasks, type RawTaskRepoOutcome } from "./taskArchival.ts";
import { runFinalization } from "./runAuthorization.ts";
export type CliInput = WorkflowArguments & {
    runId?: string; startTimestamp?: string; doneCount?: number; partialCount?: number; blockedCount?: number;
    needsClarificationCount?: number; requeueCount?: number; testReceipts?: TestReceipt[]; reviewHandoffs?: string[];
    repositoryManifest: RepositoryManifest;
};
export type SubmoduleConflict = { path: string; conflictedFilePaths: string[]; failureReason: string | null };
export type MergeOutcome = { groupId: number; merged: boolean; conflictedFilePaths: string[]; submoduleConflicts: SubmoduleConflict[]; worktree: string; failureReason: string | null };
export type PublicationTargetSummary = { repositoryPath: string; recordedBaseOid: string; targetOid: string };
type Coordinate = { repoRoot: string; relativePath: string };
type LogicalGroup = { logicalId: string; occurrenceIds: string[]; canonicalOccurrenceId: string };
type ConsolidationOutcome = { preparedIntegrationOid: string; canonicalRepoRoot: string; canonicalRefName: string; recordedBaseOid: string; integrationRef: string };
function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function sanitizeSegment(segment: string): string {
    const cleaned = segment.replace(/[^A-Za-z0-9_-]/g, "-") || "seg";
    return `${cleaned}-${createHash("sha256").update(segment).digest("hex").slice(0, 8)}`;
}
function digestIds(ids: string[]): string { return createHash("sha256").update([...ids].sort().join("\n")).digest("hex"); }
function parseMergeTreeConflicts(stdout: string): string[] {
    const [, ...lines] = (stdout.split("\n\n")[0] ?? "").split("\n");
    return [...new Set(lines.filter(Boolean).map((line) => line.split("\t")[1]))];
}
function occurrenceToLogicalId(groups: LogicalGroup[], occurrenceId: string): string { return groups.find((g) => g.occurrenceIds.includes(occurrenceId))!.logicalId; }
function buildCoordinates(repo: string, manifest: RepositoryManifest): Map<string, Coordinate> {
    const repoResolved = resolve(repo);
    const coordinates = new Map<string, Coordinate>();
    for (const occurrence of manifest.occurrences) {
        const repoRoot = occurrence.checkoutPath.startsWith("/") ? occurrence.checkoutPath : join(repo, occurrence.checkoutPath);
        const relativePath = repoRoot === repoResolved ? "" : relative(repoResolved, repoRoot);
        if (relativePath.startsWith("..")) throw new Error(`occurrence "${occurrence.occurrenceId}" checkout path "${repoRoot}" is outside repo "${repo}"`);
        coordinates.set(occurrence.occurrenceId, { repoRoot, relativePath: relativePath === "." ? "" : relativePath });
    }
    return coordinates;
}
function identityKey(occurrence: RepositoryOccurrence): string {
    if (occurrence.originUrl === "") return `blank:${occurrence.occurrenceId}`;
    const parsed = normalizeRepositoryIdentity(occurrence.originUrl);
    return parsed ? `parsed:${parsed.host}/${parsed.owner}/${parsed.repository}` : `opaque:${occurrence.originUrl}`;
}
function buildLogicalGroups(manifest: RepositoryManifest): LogicalGroup[] {
    const byKey = new Map<string, string[]>();
    for (const occurrence of manifest.occurrences) {
        const key = identityKey(occurrence);
        const existing = byKey.get(key);
        if (existing) existing.push(occurrence.occurrenceId); else byKey.set(key, [occurrence.occurrenceId]);
    }
    return [...byKey.entries()].map(([key, occurrenceIds]) => ({ logicalId: sanitizeSegment(key), occurrenceIds, canonicalOccurrenceId: occurrenceIds[0] }));
}
// Post-order DFS over occurrence childOccurrenceIds mapped through their owning logical group: children before parents.
function topoOrderLogicalGroups(groups: LogicalGroup[], manifest: RepositoryManifest): LogicalGroup[] {
    const occurrenceToLogical = new Map<string, string>();
    for (const group of groups) for (const id of group.occurrenceIds) occurrenceToLogical.set(id, group.logicalId);
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    const byId = new Map(groups.map((g) => [g.logicalId, g]));
    const mark = new Map<string, "gray" | "black">();
    const order: LogicalGroup[] = [];
    function visit(logicalId: string, path: string[]): void {
        if (mark.get(logicalId) === "black") return;
        if (mark.get(logicalId) === "gray") throw new Error(`logical repository dependency cycle: ${[...path, logicalId].join(" -> ")}`);
        mark.set(logicalId, "gray");
        const group = byId.get(logicalId)!;
        for (const occurrenceId of group.occurrenceIds) for (const childId of occurrenceById.get(occurrenceId)!.childOccurrenceIds) {
            const childLogicalId = occurrenceToLogical.get(childId)!;
            if (childLogicalId !== logicalId) visit(childLogicalId, [...path, logicalId]);
        }
        mark.set(logicalId, "black");
        order.push(group);
    }
    for (const group of groups) visit(group.logicalId, []);
    return order;
}
export async function runMergePipeline(input: CliInput): Promise<void> {
    const manifest = input.repositoryManifest;
    if (!manifest) throw new Error("no repository manifest given in CLI input; approval cannot be minted without pre-merge base OIDs");
    const validation = validateRepositoryManifest(manifest);
    if (!validation.valid) throw new Error(`invalid repository manifest: ${validation.errors.join("; ")}`);
    const roots = manifest.occurrences.filter((o) => o.parentOccurrenceId === null);
    if (roots.length !== 1) throw new Error(`repository manifest must have exactly one root occurrence, found ${roots.length}`);
    if (input.groups.length === 0) throw new Error("no groups given in CLI input");
    const rootOccurrence = roots[0];
    const occurrenceById = new Map(manifest.occurrences.map((o) => [o.occurrenceId, o]));
    const runId = input.runId ?? `merge-${Date.now()}-${process.pid}`;
    execFileSync("git", ["check-ref-format", `refs/heads/${runId}/probe`]);
    const sortedGroups = [...input.groups].sort((a, b) => a.groupId - b.groupId);
    const testReceipts = input.testReceipts ?? [];
    const reviewHandoffs = input.reviewHandoffs ?? [];
    const coordinates = buildCoordinates(input.repo, manifest);
    const logicalGroups = topoOrderLogicalGroups(buildLogicalGroups(manifest), manifest);
    const groupRepoRootFor = (groupWorktree: string, occurrenceId: string): string =>
        coordinates.get(occurrenceId)!.relativePath === "" ? groupWorktree : join(groupWorktree, coordinates.get(occurrenceId)!.relativePath);
    const rawTips = new Map<string, Map<number, string>>();
    for (const occurrence of manifest.occurrences) rawTips.set(occurrence.occurrenceId, new Map(sortedGroups.map((group) => [group.groupId, git(groupRepoRootFor(group.worktree, occurrence.occurrenceId), "rev-parse", "HEAD").trim()])));
    const baseMismatch = logicalGroups.find((group) => new Set(group.occurrenceIds.map((id) => occurrenceById.get(id)!.baseOid)).size > 1);
    const merged: MergeOutcome[] = [];
    const conflicts: MergeOutcome[] = [];
    for (const group of sortedGroups) {
        const submoduleConflicts: SubmoduleConflict[] = [];
        let rootConflictedPaths: string[] = [];
        let failed = baseMismatch !== undefined;
        for (const occurrence of manifest.occurrences) {
            const coordinate = coordinates.get(occurrence.occurrenceId)!;
            const groupRepoRoot = groupRepoRootFor(group.worktree, occurrence.occurrenceId);
            const tipOid = rawTips.get(occurrence.occurrenceId)!.get(group.groupId)!;
            try {
                execFileSync("git", ["-C", groupRepoRoot, "merge-tree", "--write-tree", occurrence.baseOid, tipOid], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
            } catch (error) {
                failed = true;
                const conflictedPaths = parseMergeTreeConflicts((error as { stdout?: string }).stdout ?? "");
                if (coordinate.relativePath === "") rootConflictedPaths = conflictedPaths;
                else submoduleConflicts.push({ path: coordinate.relativePath, conflictedFilePaths: conflictedPaths, failureReason: null });
            }
        }
        const outcome: MergeOutcome = { groupId: group.groupId, merged: !failed, conflictedFilePaths: failed ? rootConflictedPaths : [], submoduleConflicts, worktree: group.worktree, failureReason: null };
        (failed ? conflicts : merged).push(outcome);
    }
    const allGroupsMerged = conflicts.length === 0;
    const occurrenceSnapshots: OccurrenceSnapshot[] = merged.flatMap((outcome) => manifest.occurrences.map((occurrence) => ({
        groupId: outcome.groupId, repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath,
        treeListing: git(groupRepoRootFor(outcome.worktree, occurrence.occurrenceId), "ls-tree", "-r", "-z", "HEAD"),
    })));
    const occurrenceDigests = computeOccurrenceDigests(occurrenceSnapshots);
    const files = [...new Set(sortedGroups.flatMap((group) => group.tasks.flatMap((task) => task.files)))];
    const operationRef = digestIds(sortedGroups.flatMap((group) => manifest.occurrences.map((o) => `${group.groupId}:${o.occurrenceId}:${rawTips.get(o.occurrenceId)!.get(group.groupId)}`)));
    const readyForApproval = allGroupsMerged && testReceipts.length > 0 && testReceipts.every((receipt) => receipt.status === "green") && reviewHandoffs.length > 0;
    const digestInput: ApprovalDigestInput = { manifest, files, operationRef, baseRef: rootOccurrence.baseOid, occurrenceDigests, testReceipts, reviewHandoffs };
    const runState: RunState = { readyForApproval, status: readyForApproval ? "approved" : "blocked", digestInput };
    const endMetrics = (conflictCount: number): void => {
        const endTimestamp = new Date().toISOString();
        const workflowArguments: WorkflowArguments = { repo: input.repo, typecheckCommand: input.typecheckCommand, groups: input.groups, repositorySources: input.repositorySources };
        appendRunMetricsRecord(input.repo, {
            runId: input.runId ?? endTimestamp, startTimestamp: input.startTimestamp ?? null, endTimestamp,
            durationMs: runDurationMs(input.startTimestamp ?? null, endTimestamp),
            taskNumbers: sortedGroups.flatMap((g) => g.tasks.map((t) => t.number)), groupCount: sortedGroups.length,
            doneCount: input.doneCount ?? 0, partialCount: input.partialCount ?? 0, blockedCount: input.blockedCount ?? 0,
            needsClarificationCount: input.needsClarificationCount ?? 0, requeueCount: input.requeueCount ?? 0,
            conflictCount, argumentsHash: computeArgumentsHash(workflowArguments),
        });
    };
    const printResult = (publicationTargets: PublicationTargetSummary[], abortReason: string | null = null): void => { process.stdout.write(JSON.stringify({ merged, conflicts, testReceipts, reviewHandoffs, occurrenceDigests, runState, publicationTargets, abortReason })); };
    if (!readyForApproval) { endMetrics(conflicts.length); printResult([]); return; }
    recordApproval(runState);
    const token = issueApprovalAuthorization(runState);
    const digest = computeApprovalDigest(runState.digestInput); let abortReason: string | null = null;
    const aborted = await runFinalization(token, digest, async (): Promise<boolean> => {
        const consolidations = new Map<string, ConsolidationOutcome>();
        for (const logicalGroup of logicalGroups) {
            const canonicalRepoRoot = coordinates.get(logicalGroup.canonicalOccurrenceId)!.repoRoot;
            const canonicalOccurrence = occurrenceById.get(logicalGroup.canonicalOccurrenceId)!;
            const participatingBranches: GroupOccurrenceBranch[] = [];
            for (const occurrenceId of logicalGroup.occurrenceIds) {
                const occurrence = occurrenceById.get(occurrenceId)!;
                const occurrenceSegment = sanitizeSegment(occurrenceId);
                for (const group of sortedGroups) {
                    const repoRoot = groupRepoRootFor(group.worktree, occurrenceId);
                    const proxyId = (childId: string): string => `proxy-${sanitizeSegment(childId)}`;
                    const directChildEdges = occurrence.childOccurrenceIds.map((childId) => ({ pathInParent: occurrenceById.get(childId)!.pathInParent!, childOccurrenceId: proxyId(childId) }));
                    const proxyInputs = occurrence.childOccurrenceIds.map((childId) => {
                        const child = consolidations.get(occurrenceToLogicalId(logicalGroups, childId))!;
                        return { occurrenceId: proxyId(childId), repoRoot: child.canonicalRepoRoot, currentTipOid: child.preparedIntegrationOid, recordedBaseOid: child.preparedIntegrationOid, approvedOwnFileChanges: [], directChildEdges: [] };
                    });
                    const finalizationRunId = `${runId}-finalize-${sanitizeSegment(logicalGroup.logicalId)}-${group.groupId}`;
                    const result = finalizeApprovedRun(runState, {
                        runId: finalizationRunId,
                        occurrences: [{ occurrenceId: occurrenceSegment, repoRoot, currentTipOid: rawTips.get(occurrenceId)!.get(group.groupId)!, recordedBaseOid: rawTips.get(occurrenceId)!.get(group.groupId)!, approvedOwnFileChanges: [], directChildEdges }, ...proxyInputs],
                    });
                    const finalizedOid = result.occurrences.find((o) => o.occurrenceId === occurrenceSegment)!.finalizedIntegrationOid;
                    const groupSegment = String(group.groupId).padStart(6, "0");
                    if (repoRoot !== canonicalRepoRoot) git(canonicalRepoRoot, "fetch", repoRoot, finalizedOid);
                    git(canonicalRepoRoot, "update-ref", `refs/heads/${groupSegment}/${occurrenceSegment}`, finalizedOid);
                    participatingBranches.push({ groupId: groupSegment, occurrencePath: occurrenceSegment, occurrenceId, branchOid: finalizedOid, sourceRepoRoot: canonicalRepoRoot });
                }
            }
            const sorted = [...participatingBranches].sort((a, b) => a.groupId.localeCompare(b.groupId) || a.occurrencePath.localeCompare(b.occurrencePath));
            let previewOid = sorted[0].branchOid;
            for (let i = 1; i < sorted.length; i++) {
                const foldResult = prepareNoFfMerge(canonicalRepoRoot, previewOid, sorted[i].branchOid, `preview fold ${runId}`);
                if (!foldResult.merged) return true; else previewOid = foldResult.commitOid;
            }
            const approvedConvergedTreeOid = git(canonicalRepoRoot, "rev-parse", `${previewOid}^{tree}`).trim();
            const consolidationInput: LogicalRepositoryConsolidationInput = {
                logicalRepositoryId: logicalGroup.logicalId, canonicalRepoRoot, canonicalOccurrenceBranchName: sanitizeSegment(logicalGroup.logicalId),
                participatingBranches, approvedConvergedTreeOid, finalizedChildGitlinks: [],
                recordedBaseOid: canonicalOccurrence.baseOid, baseBranchRef: `refs/heads/${canonicalOccurrence.baseBranch}`,
            };
            const [result] = consolidateRun(runId, [consolidationInput], token, digest);
            if ("aborted" in result) return true;
            const integrationRef = `refs/finalize/${runId}/integration/${sanitizeSegment(logicalGroup.logicalId)}`;
            git(canonicalRepoRoot, "update-ref", integrationRef, result.preparedIntegrationOid);
            consolidations.set(logicalGroup.logicalId, { preparedIntegrationOid: result.preparedIntegrationOid, canonicalRepoRoot, canonicalRefName: `refs/heads/${canonicalOccurrence.baseBranch}`, recordedBaseOid: canonicalOccurrence.baseOid, integrationRef });
        }
        const operationPushOccurrences = manifest.occurrences.map((occurrence) => {
            const logicalGroup = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            return { ...occurrence, operationBranch: `operations/${runId}/${sanitizeSegment(logicalGroup.logicalId)}` };
        });
        const operationPushLogicalRepositories: LogicalRepository[] = logicalGroups.map((group) => ({
            normalizedIdentity: normalizeRepositoryIdentity(occurrenceById.get(group.canonicalOccurrenceId)!.originUrl) ?? ({ host: "opaque", owner: "opaque", repository: group.logicalId } as RepositoryIdentity),
            occurrenceIds: group.occurrenceIds, selectedBaseOccurrenceId: group.canonicalOccurrenceId, canonicalOccurrenceId: group.canonicalOccurrenceId,
            lastWriterOccurrenceId: group.occurrenceIds[group.occurrenceIds.length - 1], convergenceDigest: digestIds(group.occurrenceIds),
            consolidationState: group.occurrenceIds.length === 1 ? "single" : "grouped",
        }));
        await pushOperationBranches({ logicalRepositories: operationPushLogicalRepositories, occurrences: operationPushOccurrences }, token, digest);
        for (const occurrence of manifest.occurrences) { const liveOid = readCurrentRefOid(coordinates.get(occurrence.occurrenceId)!.repoRoot, `refs/heads/${occurrence.baseBranch}`); if (liveOid !== occurrence.baseOid) { abortReason = `the source branch moved past the pinned baseOid (pinned ${occurrence.baseOid}, now ${liveOid})`; return true; } }
        const publicationTargets: PublicationTarget[] = logicalGroups.map((group) => {
            const consolidation = consolidations.get(group.logicalId)!;
            return {
                name: group.logicalId, canonicalOccurrencePath: consolidation.canonicalRepoRoot, canonicalRefName: consolidation.canonicalRefName,
                otherOccurrences: group.occurrenceIds.filter((id) => id !== group.canonicalOccurrenceId).map((id) => ({ path: coordinates.get(id)!.repoRoot, refName: `refs/heads/${occurrenceById.get(id)!.baseBranch}` })),
                recordedBaseOid: consolidation.recordedBaseOid, targetOid: consolidation.preparedIntegrationOid,
            };
        });
        const rootConsolidation = consolidations.get(logicalGroups.find((g) => g.occurrenceIds.includes(rootOccurrence.occurrenceId))!.logicalId)!;
        const publicationResult = publishBases(publicationTargets, runState, { repoPath: rootConsolidation.canonicalRepoRoot, refName: rootConsolidation.integrationRef });
        if (!publicationResult.published) return true;
        const rawOutcomes: RawTaskRepoOutcome[] = sortedGroups.flatMap((group) => group.tasks.flatMap((task) => logicalGroups.map((logicalGroup) => ({
            taskNumber: task.number, repo: { repoName: logicalGroup.logicalId, status: "published" as const, commitHash: consolidations.get(logicalGroup.logicalId)!.preparedIntegrationOid },
        }))));
        const mergeResults = summarizeTaskMergeResults(rawOutcomes);
        archivePublishedTasks(sortedGroups.flatMap((group) => group.tasks.map((task) => task.number)), mergeResults, input.repo);
        for (const resolvePath of [resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath]) rmSync(resolvePath(input.repo), { force: true });
        const summaryTargets: PublicationTargetSummary[] = manifest.occurrences.map((occurrence) => {
            const group = logicalGroups.find((g) => g.occurrenceIds.includes(occurrence.occurrenceId))!;
            const consolidation = consolidations.get(group.logicalId)!;
            return { repositoryPath: coordinates.get(occurrence.occurrenceId)!.relativePath, recordedBaseOid: occurrence.baseOid, targetOid: consolidation.preparedIntegrationOid };
        });
        endMetrics(0);
        printResult(summaryTargets);
        return false;
    });
    if (aborted) { endMetrics(conflicts.length + 1); printResult([], abortReason); }
}
