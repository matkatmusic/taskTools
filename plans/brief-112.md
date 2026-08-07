# Task 112: Stop archiving tasks against commits that do not contain their code, and gate archival on the merge phase actually succeeding

## User request

The merge pipeline archives a task as completed against an empty consolidation commit even when the merge phase then reports blocked, so a task can read as done while none of its code is in the tree. Observed on 2026-08-07 in run msj8czjj-r3odjv8prf8 for task 77. What happened, all verified against git: mergeTaskWorktrees.ts produced commit 844bf46 titled runConsolidation msj8czjj-r3odjv8prf8: integrate parsed-github-com-matkatmusic-tasktools-572765a1. That commit is empty - git show --stat shows no file changes at all - and git cat-file -e 844bf46:scripts/taskStatsBrief.ts fails, so it does not contain any of task 77's three files. Despite that, the pipeline moved task 77 out of tasks.json into completedTasks.json with completionDate 2026-08-07, commitHashes [844bf46], and closureNote absent entirely (jq reports null). runMergePhase.ts then returned status blocked for the same run. So the archival happened on a run that the merge phase itself judged unsuccessful, and it recorded a hash proving nothing. Task 77's code only reached new-usage-graph because it was hand fast-forwarded from task-group-1 afterwards as commit 17b6c6e; without that manual step the task would have been permanently marked done with its work stranded on an unmerged branch. Two separate defects are worth fixing together: (a) archival must not run, or must be rolled back, when the merge phase reports blocked - the consolidation and the closure should share one success gate; (b) a consolidation commit that integrates nothing should not be created, or at minimum should never be recorded as a task's completion hash - record the commit that actually carries the task's declared files, and verify those paths exist in it before writing commitHashes. A cheap invariant to enforce: before archiving task N with hash H, assert every path in that task's files array exists in H (git cat-file -e H:path), and refuse to archive otherwise. Note this is distinct from task 108, which is about the base-drift retry being unable to run; this one is about closing tasks against commits that do not contain their code, and it is the more damaging of the two because it silently loses work. Files likely involved: scripts/mergePipeline.ts, scripts/mergeTaskWorktrees.ts, scripts/runMergePhase.ts, scripts/taskArchival.ts, scripts/closeTasks.ts, tests/mergePipeline.test.ts, tests/taskArchival.test.ts.

Live incident captured 2026-08-07 while landing task 77 through tackle-tasks run msj8czjj-r3odjv8prf8. Every claim below was checked against git in the working repo rather than inferred.\n\nEvidence:\n- Commit 844bf46239578152d2614df8fca7f26381b2eed3, subject 'runConsolidation msj8czjj-r3odjv8prf8: integrate parsed-github-com-matkatmusic-tasktools-572765a1', is empty: git show --stat --oneline 844bf46 prints the subject line and no file stats.\n- git cat-file -e 844bf46:scripts/taskStatsBrief.ts exits non-zero, so none of task 77's declared files (scripts/taskStatsBrief.ts, skills/task-stats/SKILL.md, tests/taskStatsBrief.test.ts) are in that tree.\n- Task 77's record in .taskTools/completedTasks.json nonetheless carried completionDate 2026-08-07 and commitHashes [844bf462...], with no closureNote key at all.\n- For the same run, node scripts/runMergePhase.ts returned {\"status\":\"blocked\",...}. So the archival and the blocked verdict came from one run.\n- An operation branch operations/msj8czjj-r3odjv8prf8/parsed-github-com-matkatmusic-tasktools-572765a1-c8146a02 exists and contains 844bf46, confirming the consolidation step ran to completion before the phase reported blocked.\n\nWhy it matters: the code reached new-usage-graph only because task-group-1 was hand fast-forwarded afterwards (17b6c6ea7408f3d326acba857213257db9328369). Absent that manual rescue the task would sit permanently in completedTasks.json with its work stranded on an unmerged branch and no way to notice - the recorded hash is a real commit, so a reader auditing the closure finds nothing obviously wrong. Task 77's record has since been corrected by hand to point at 17b6c6ea with a real closureNote; that correction is a one-off patch, not a fix for the underlying behaviour.\n\nTwo defects, one shared gate:\n(a) consolidation/archival and the merge phase's own verdict are not gated together - archival proceeded on a run runMergePhase judged blocked. They need a single success gate so a blocked verdict means nothing was archived (or the archival is rolled back).\n(b) an integration commit that changes no files should not be created, and must never be recorded as a task's completion hash. The recorded hash should be the commit that actually carries the task's declared files.\n\nProposed cheap invariant, agreed while writing this task: before archiving task N against hash H, assert every path in that task's files array resolves in H (git cat-file -e H:path) and refuse to archive otherwise. This is a few lines and catches both defects' symptoms even if the root ordering fix is imperfect.\n\nRelationship to task 108: distinct and independent. 108 is about coordinateMergeRetry being unable to run after base drift; this one is about closing tasks against commits that lack their code. This one is the more damaging - 108 fails loudly and blocks, this one succeeds quietly and loses work. Both surfaced in the same run.

### scripts/mergePipeline.ts

```
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
import { buildOperationPushOccurrences } from "./operationBranches.ts";
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
        const operationBranchSegments = new Map(logicalGroups.flatMap((group) => group.occurrenceIds.map((id) => [id, sanitizeSegment(group.logicalId)] as const)));
        const operationPushOccurrences = buildOperationPushOccurrences(manifest.occurrences, runId, operationBranchSegments);
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

```

### scripts/mergeTaskWorktrees.ts

```
// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { type PreparedGroup, type WorkflowArguments } from "./prepareTasks.ts";
import { collectRepositorySources, currentBranchName } from "./repositoryBranches.ts";
import { declaredFiles } from "./taskGroups.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { runMergePipeline } from "./mergePipeline.ts";
import type { MergeOutcome, SubmoduleConflict } from "./mergePipeline.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitErrorText(error: unknown): string {
    const failure = error as { stderr?: string; message?: string };
    return (failure.stderr || failure.message || "git merge failed").trim();
}

export type TaskWorktree = { path: string; branch: string };

function parseWorktreeListPorcelain(output: string): TaskWorktree[] {
    const blocks = output.split("\n\n").map((block) => block.trim()).filter(Boolean);
    const worktrees: TaskWorktree[] = [];
    for (const block of blocks) {
        const lines = block.split("\n");
        const pathLine = lines.find((line) => line.startsWith("worktree "));
        const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
        if (!pathLine) continue;
        if (!branchLine) continue;
        worktrees.push({
            path: pathLine.slice("worktree ".length),
            branch: branchLine.slice("branch refs/heads/".length),
        });
    }
    return worktrees;
}

export function listTaskWorktrees(repoRoot: string): TaskWorktree[] {
    const conventionDir = join(tmpdir(), "taskTools-wt", basename(repoRoot));
    // git resolves symlinks in the paths it reports (e.g. macOS /var -> /private/var); match on the resolved form.
    if (!existsSync(conventionDir)) return [];
    const conventionRoot = realpathSync(conventionDir);
    const output = git(repoRoot, "worktree", "list", "--porcelain");
    return parseWorktreeListPorcelain(output).filter((worktree) => {
        if (!worktree.path.startsWith(`${conventionRoot}/`)) return false;
        return /^group-\d+$/.test(basename(worktree.path));
    });
}

function unmergedCommitCount(repoRoot: string, sourceBranch: string, branch: string): number {
    return Number(git(repoRoot, "rev-list", "--count", `${sourceBranch}..${branch}`).trim());
}

function commitChangedFiles(repoRoot: string, sourceBranch: string, branch: string): string[] {
    return git(repoRoot, "diff", "--name-only", `${sourceBranch}...${branch}`).split("\n").filter(Boolean);
}

// Porcelain v1 rename lines read "R  old -> new"; every other status line is "XY path".
function uncommittedChangedFiles(worktreePath: string): string[] {
    return git(worktreePath, "status", "--porcelain").split("\n").filter(Boolean).map((line) => {
        const path = line.slice(3);
        if (!path.includes(" -> ")) return path;
        return path.split(" -> ")[1];
    });
}

export type UnmergedTaskWorktree = {
    worktree: string;
    branch: string;
    unmergedCommitCount: number;
    hasUncommittedChanges: boolean;
    changedFilePaths: string[];
    matchedTaskNumbers: number[];
};

export function findUnmergedTaskWorktrees(
    repoRoot: string,
    sourceBranch: string,
    openTasks: TaskRecord[],
): UnmergedTaskWorktree[] {
    const results = listTaskWorktrees(repoRoot).map((worktree) => {
        const commitChanged = commitChangedFiles(repoRoot, sourceBranch, worktree.branch);
        const uncommittedChanged = uncommittedChangedFiles(worktree.path);
        const changedFilePaths = [...new Set([...commitChanged, ...uncommittedChanged])];
        const matchedTaskNumbers = openTasks
            .filter((task) => declaredFiles(task).some((file) => changedFilePaths.includes(file)))
            .map((task) => task.taskNumber);
        return {
            worktree: worktree.path,
            branch: worktree.branch,
            unmergedCommitCount: unmergedCommitCount(repoRoot, sourceBranch, worktree.branch),
            hasUncommittedChanges: uncommittedChanged.length > 0,
            changedFilePaths,
            matchedTaskNumbers,
        };
    });
    return results.filter((r) => r.unmergedCommitCount > 0 || r.hasUncommittedChanges);
}

export type RebaseOutcome =
    | { status: "rebased-clean" }
    | { status: "conflicted"; conflictedFilePaths: string[] }
    | { status: "cleanup-failed"; failureReason: string };

function rebaseGitPath(worktreePath: string, relativePath: string): string {
    const output = git(worktreePath, "rev-parse", "--git-path", relativePath).trim();
    return isAbsolute(output) ? output : join(worktreePath, output);
}

function rebaseInProgress(worktreePath: string): boolean {
    return existsSync(rebaseGitPath(worktreePath, "rebase-merge")) || existsSync(rebaseGitPath(worktreePath, "rebase-apply"));
}

function collectConflictedRebasePaths(worktreePath: string): string[] {
    return git(worktreePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
}

function abortRebase(worktreePath: string): { aborted: boolean; failureReason: string | null } {
    try {
        git(worktreePath, "rebase", "--abort");
        return { aborted: true, failureReason: null };
    } catch (error) {
        return { aborted: false, failureReason: gitErrorText(error) };
    }
}

function combineFailureReasons(...parts: (string | null)[]): string {
    return parts.filter((part): part is string => part !== null).join("; ");
}

export function rebaseGroupOntoSource(worktreePath: string, sourceBranch: string): RebaseOutcome {
    try {
        git(worktreePath, "rebase", sourceBranch);
        return { status: "rebased-clean" };
    } catch (rebaseError) {
        const originalReason = gitErrorText(rebaseError);

        let inProgress: boolean;
        try {
            inProgress = rebaseInProgress(worktreePath);
        } catch (stateError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, gitErrorText(stateError), abortFailure) };
        }

        if (!inProgress) return { status: "cleanup-failed", failureReason: originalReason };

        let conflictedFilePaths: string[];
        try {
            conflictedFilePaths = collectConflictedRebasePaths(worktreePath);
        } catch (collectionError) {
            const abortResult = abortRebase(worktreePath);
            const abortFailure = abortResult.aborted ? null : `abort also failed: ${abortResult.failureReason}`;
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, gitErrorText(collectionError), abortFailure) };
        }

        const abortResult = abortRebase(worktreePath);
        if (!abortResult.aborted) {
            return { status: "cleanup-failed", failureReason: combineFailureReasons(originalReason, `abort also failed: ${abortResult.failureReason}`) };
        }

        if (conflictedFilePaths.length === 0) return { status: "cleanup-failed", failureReason: originalReason };

        return { status: "conflicted", conflictedFilePaths };
    }
}

export function mergeGroupBranchIntoRepo(
    repoRoot: string,
    group: PreparedGroup,
    sourceBranch: string,
    submodulePaths: string[] = [],
): MergeOutcome {
    git(repoRoot, "checkout", sourceBranch);
    const outcome = { groupId: group.groupId, submoduleConflicts: [], worktree: group.worktree };
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", `merge ${group.branch}`);
        return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
    } catch (error) {
        const resolution = resolveGitlinkConflicts(repoRoot, submodulePaths);
        if (resolution.resolved) return { ...outcome, merged: true, conflictedFilePaths: [], failureReason: null };
        const failureReason = resolution.startFailed ? gitErrorText(error) : null;
        return { ...outcome, merged: false, conflictedFilePaths: resolution.unexpectedConflicts, failureReason };
    }
}

export function resolveGitlinkConflicts(
    repoRoot: string,
    submodulePaths: string[],
): { resolved: boolean; unexpectedConflicts: string[]; startFailed: boolean } {
    const conflictedPaths = git(repoRoot, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    // No unmerged paths means the merge never started, so there is nothing to abort, stage, or commit.
    if (conflictedPaths.length === 0) return { resolved: false, unexpectedConflicts: [], startFailed: true };
    const unexpectedConflicts = conflictedPaths.filter((path) => !submodulePaths.includes(path));
    if (unexpectedConflicts.length > 0) {
        git(repoRoot, "merge", "--abort");
        return { resolved: false, unexpectedConflicts, startFailed: false };
    }
    for (const path of conflictedPaths) git(repoRoot, "add", path);
    git(repoRoot, "commit", "--no-edit");
    return { resolved: true, unexpectedConflicts: [], startFailed: false };
}

export function mergeSubmoduleBranchIntoRepo(
    mainSubmodulePath: string,
    worktreeSubmodulePath: string,
    sourceBranch: string,
): { merged: boolean; conflictedFilePaths: string[]; failureReason: string | null } {
    const groupBranch = currentBranchName(worktreeSubmodulePath);
    git(mainSubmodulePath, "fetch", worktreeSubmodulePath, `${groupBranch}:refs/heads/${groupBranch}`);
    git(mainSubmodulePath, "checkout", sourceBranch);
    try {
        git(mainSubmodulePath, "merge", "--no-ff", groupBranch, "-m", `merge ${groupBranch}`);
        return { merged: true, conflictedFilePaths: [], failureReason: null };
    } catch (error) {
        const conflictedFilePaths = git(mainSubmodulePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
        // Same rule as the parent repo: with no unmerged paths there is no merge in progress to abort.
        if (conflictedFilePaths.length === 0) return { merged: false, conflictedFilePaths, failureReason: gitErrorText(error) };
        git(mainSubmodulePath, "merge", "--abort");
        return { merged: false, conflictedFilePaths, failureReason: null };
    }
}

export function removeWorktreeAndBranch(repoRoot: string, worktreePath: string, branchName: string): void {
    git(repoRoot, "worktree", "remove", worktreePath, "--force");
    git(repoRoot, "branch", "-D", branchName);
}

function runDiscoverCli(): void {
    const repoRoot = process.cwd();
    const sourceBranch = currentBranchName(repoRoot);
    const pair = resolveTaskFiles(repoRoot);
    const openTasks = readTaskFile(pair.tasksPath);
    const results = findUnmergedTaskWorktrees(repoRoot, sourceBranch, openTasks);
    process.stdout.write(JSON.stringify(results));
}

function runMergeCli(worktreePath: string): void {
    const repoRoot = process.cwd();
    const repositorySources = collectRepositorySources(repoRoot);
    const parentSource = repositorySources.find((source) => source.path === "");
    if (!parentSource) throw new Error(`no recorded source branch for repository path "${repoRoot}"`);
    const submodulePathsDeepestFirst = repositorySources
        .map((source) => source.path)
        .filter((path) => path !== "")
        .sort((a, b) => b.split("/").length - a.split("/").length);
    const branch = currentBranchName(worktreePath);
    const group: PreparedGroup = { groupId: 0, worktree: worktreePath, branch, scope: "unknown", tasks: [] };
    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, parentSource.sourceBranch, submodulePathsDeepestFirst);
    if (outcome.merged) removeWorktreeAndBranch(repoRoot, worktreePath, branch);
    process.stdout.write(JSON.stringify(outcome));
}

async function runAsCli(): Promise<void> {
    const mode = process.argv[2];
    if (mode === "--discover") {
        runDiscoverCli();
        return;
    }
    if (mode === "--merge") {
        runMergeCli(process.argv[3]);
        return;
    }
    if (mode === "--run") {
        const prepared = JSON.parse(readFileSync(process.argv[3], "utf8"));
        const outcomesFile = process.argv[4];
        const outcomes = outcomesFile && existsSync(outcomesFile) ? JSON.parse(readFileSync(outcomesFile, "utf8")) : {};
        await runMergePipeline({ ...prepared, ...outcomes });
        return;
    }
    await runMergePipeline(JSON.parse(process.argv[2]));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    runAsCli().catch((error) => {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    });
}

```

### scripts/runMergePhase.ts

```
#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readCurrentRefOid } from "./basePublication.ts";
import type { CliInput } from "./mergePipeline.ts";
import { rebaseGroupOntoSource, type RebaseOutcome } from "./mergeTaskWorktrees.ts";
import { generateRunId, resolveMergeScriptPath, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "./prepareTasks.ts";
import type { TestReceipt } from "./approvalReadiness.ts";
import type { RepositoryOccurrence } from "./repositoryManifest.ts";
import { createEmptyResolutionManifest, type ResolutionManifest } from "./resolutionRequests.ts";
import { discoverTestPolicy, type TestPolicyResult } from "./testPolicy.ts";

export type StepOutputs = {
    done?: unknown[];
    partial?: unknown[];
    blocked?: unknown[];
    needsClarification?: unknown[];
    requeueCount?: number;
    testReceipts?: TestReceipt[];
    reviewHandoffs?: string[];
};

export type MergeFailure = { repo: string; failedCommand: string; conflicts: unknown[]; error: string };
export type MergePhaseVerdict = { status: "merged" | "blocked"; result: unknown; failure: MergeFailure | null };

export function buildMergeOutcomes(steps: StepOutputs) {
    return {
        doneCount: steps.done?.length ?? 0,
        partialCount: steps.partial?.length ?? 0,
        blockedCount: steps.blocked?.length ?? 0,
        needsClarificationCount: steps.needsClarification?.length ?? 0,
        requeueCount: steps.requeueCount ?? 0,
        testReceipts: steps.testReceipts ?? [],
        reviewHandoffs: steps.reviewHandoffs ?? [],
    };
}

type ScriptRun = { exitCode: number; stdout: string; stderr: string };

export function judgeMergeRun(run: ScriptRun, repo: string, failedCommand: string): MergePhaseVerdict {
    const blocked = (error: string, conflicts: unknown[], result: unknown): MergePhaseVerdict =>
        ({ status: "blocked", result, failure: { repo, failedCommand, conflicts, error } });
    if (run.exitCode !== 0) return blocked(`${run.exitCode}: ${run.stderr || run.stdout}`, [], null);
    let output: { conflicts?: unknown[]; publicationTargets?: unknown[] };
    try {
        output = JSON.parse(run.stdout);
    } catch {
        return blocked(`merge script printed output that is not JSON: ${run.stdout.slice(0, 500)}`, [], null);
    }
    if ((output.conflicts?.length ?? 0) > 0) return blocked("", output.conflicts!, output);
    if ((output.publicationTargets?.length ?? 0) === 0)
        return blocked("merge script exited clean but published nothing (publicationTargets is empty): the run was not ready for approval, or the source branch moved past its pinned baseOid before publish", [], output);
    return { status: "merged", result: output, failure: null };
}

function runScript(command: string[], cwd?: string): ScriptRun {
    try {
        return { exitCode: 0, stdout: execFileSync(command[0]!, command.slice(1), { encoding: "utf8", cwd }), stderr: "" };
    } catch (error) {
        const failed = error as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
}

function blockedVerdict(repo: string, failedCommand: string, error: string): MergePhaseVerdict {
    return { status: "blocked", result: null, failure: { repo, failedCommand, conflicts: [], error } };
}

function resultIndicatesBaseDrift(verdict: MergePhaseVerdict): boolean {
    const result = verdict.result as { abortReason?: string | null } | null;
    return typeof result?.abortReason === "string" && result.abortReason.startsWith("the source branch moved past the pinned baseOid");
}

function confirmedBaseDrift(verdict: MergePhaseVerdict): boolean {
    return verdict.status === "blocked" && resultIndicatesBaseDrift(verdict);
}

function describeRebaseFailure(outcome: RebaseOutcome): string {
    if (outcome.status === "conflicted") return `rebase conflicted: ${outcome.conflictedFilePaths.join(", ")}`;
    if (outcome.status === "cleanup-failed") return outcome.failureReason;
    return "rebase reported unexpected clean status while being treated as a failure";
}

function occurrencePathInWorktree(repoRoot: string, worktree: string, checkoutPath: string): string {
    const absoluteCheckout = isAbsolute(checkoutPath) ? checkoutPath : join(repoRoot, checkoutPath);
    const relativePath = relative(resolve(repoRoot), absoluteCheckout);
    return relativePath === "" || relativePath === "." ? worktree : join(worktree, relativePath);
}

function mintFreshRunId(generate: () => string, oldRunId: string): string {
    const candidate = generate();
    return candidate === oldRunId ? `${candidate}-retry` : candidate;
}

function rewriteOperationBranches(
    occurrences: RepositoryOccurrence[],
    oldRunId: string,
    newRunId: string,
): RepositoryOccurrence[] | null {
    const oldPrefix = `operations/${oldRunId}/`;
    const rewritten: RepositoryOccurrence[] = [];
    for (const occurrence of occurrences) {
        if (!occurrence.operationBranch.startsWith(oldPrefix)) return null;
        rewritten.push({ ...occurrence, operationBranch: `operations/${newRunId}/${occurrence.operationBranch.slice(oldPrefix.length)}` });
    }
    return rewritten;
}

function refreshBaseOids(
    repoRoot: string,
    occurrences: RepositoryOccurrence[],
    readRefOid: (repoRoot: string, ref: string) => string | null,
): RepositoryOccurrence[] | null {
    const refreshed: RepositoryOccurrence[] = [];
    for (const occurrence of occurrences) {
        const checkoutRoot = isAbsolute(occurrence.checkoutPath) ? occurrence.checkoutPath : join(repoRoot, occurrence.checkoutPath);
        const oid = readRefOid(checkoutRoot, `refs/heads/${occurrence.baseBranch}`);
        if (oid === null) return null;
        refreshed.push({ ...occurrence, baseOid: oid });
    }
    return refreshed;
}

export type MergeRetryDeps = {
    runScript: (command: string[], cwd?: string) => ScriptRun;
    generateRunId: () => string;
    readRefOid: (repoRoot: string, ref: string) => string | null;
    writeRunArguments: (data: unknown) => void;
    rebaseGroupOntoSource: (worktreePath: string, sourceBranch: string) => RebaseOutcome;
    discoverTestPolicy: (occurrenceId: string, checkoutPath: string, resolutionManifest: ResolutionManifest) => TestPolicyResult;
};

export function coordinateMergeRetry(
    runArguments: CliInput,
    mergeCommand: string[],
    deps: MergeRetryDeps,
): MergePhaseVerdict {
    const sourceBranch = runArguments.repositorySources.find((source) => source.path === "")?.sourceBranch;
    if (!sourceBranch) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "no recorded source branch for repository root");

    for (const group of runArguments.groups) {
        const rebaseOutcome = deps.rebaseGroupOntoSource(group.worktree, sourceBranch);
        if (rebaseOutcome.status !== "rebased-clean") {
            return blockedVerdict(runArguments.repo, mergeCommand.join(" "), describeRebaseFailure(rebaseOutcome));
        }
        for (const occurrence of runArguments.repositoryManifest.occurrences) {
            const occurrencePath = occurrencePathInWorktree(runArguments.repo, group.worktree, occurrence.checkoutPath);
            const policyResult = deps.discoverTestPolicy(occurrence.occurrenceId, occurrencePath, createEmptyResolutionManifest());
            if (policyResult.status !== "resolved") {
                return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `test policy unresolved for occurrence "${occurrence.occurrenceId}"`);
            }
            const testRun = deps.runScript(["sh", "-c", policyResult.policy.completeSuiteCommand], occurrencePath);
            if (testRun.exitCode !== 0) {
                return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `post-rebase tests failed for occurrence "${occurrence.occurrenceId}": ${testRun.stderr || testRun.stdout}`);
            }
        }
    }

    const oldRunId = runArguments.runId;
    if (!oldRunId) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "run arguments carry no runId to retry from");
    const newRunId = mintFreshRunId(deps.generateRunId, oldRunId);
    const rewrittenOccurrences = rewriteOperationBranches(runArguments.repositoryManifest.occurrences, oldRunId, newRunId);
    if (rewrittenOccurrences === null) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `an occurrence operationBranch does not carry the expected prefix "operations/${oldRunId}/"`);
    }
    const refreshedOccurrences = refreshBaseOids(runArguments.repo, rewrittenOccurrences, deps.readRefOid);
    if (refreshedOccurrences === null) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "failed to read a refreshed base OID for an occurrence");
    }

    const updatedArguments: CliInput = {
        ...runArguments,
        runId: newRunId,
        repositoryManifest: { ...runArguments.repositoryManifest, occurrences: refreshedOccurrences },
    };
    deps.writeRunArguments(updatedArguments);

    const retryVerdict = judgeMergeRun(deps.runScript(mergeCommand), runArguments.repo, mergeCommand.join(" "));
    if (resultIndicatesBaseDrift(retryVerdict)) {
        return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "retry hit a second base-drift result; no further attempt");
    }
    return retryVerdict;
}

function runAsCli(): void {
    const repoRoot = process.cwd();
    const stepsFile = resolveStepOutputsPath(repoRoot);
    if (!existsSync(stepsFile)) throw new Error(`no step outputs at "${stepsFile}"; write them there before running the merge phase`);
    const outcomesFile = resolveRunOutcomesPath(repoRoot);
    mkdirSync(dirname(outcomesFile), { recursive: true });
    writeFileSync(outcomesFile, JSON.stringify(buildMergeOutcomes(JSON.parse(readFileSync(stepsFile, "utf8")))));
    const runArgumentsPath = resolveRunArgumentsPath(repoRoot);
    const runArguments: CliInput = JSON.parse(readFileSync(runArgumentsPath, "utf8"));
    const command = ["node", "--no-inspect", resolveMergeScriptPath(), "--run", runArgumentsPath, outcomesFile];
    const deps: MergeRetryDeps = {
        runScript,
        generateRunId,
        readRefOid: readCurrentRefOid,
        writeRunArguments: (data) => writeFileSync(runArgumentsPath, JSON.stringify(data)),
        rebaseGroupOntoSource,
        discoverTestPolicy,
    };
    const initialVerdict = judgeMergeRun(runScript(command), repoRoot, command.join(" "));
    const verdict = confirmedBaseDrift(initialVerdict) ? coordinateMergeRetry(runArguments, command, deps) : initialVerdict;
    process.stdout.write(JSON.stringify(verdict));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();

```

### scripts/taskArchival.ts

```
// Archives fully-published tasks from an explicit list; task 31's approvalGate.ts already gates this, so no re-prompt.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export type RepoPublishStatus = "published" | "conflicted" | "skipped" | "rolled-back";

export interface RepoPublishResult {
    repoName: string;
    status: RepoPublishStatus;
    commitHash?: string;
}

export interface TaskMergeResult {
    taskNumber: number;
    repos: RepoPublishResult[];
    fullyPublished: boolean;
}

export type RawTaskRepoOutcome = {
    taskNumber: number;
    repo: RepoPublishResult;
};

export function summarizeTaskMergeResults(rawOutcomes: RawTaskRepoOutcome[]): TaskMergeResult[] {
    const reposByTask = new Map<number, RepoPublishResult[]>();
    for (const outcome of rawOutcomes) {
        const repos = reposByTask.get(outcome.taskNumber) ?? [];
        repos.push(outcome.repo);
        reposByTask.set(outcome.taskNumber, repos);
    }
    return [...reposByTask.entries()].map(([taskNumber, repos]) => ({
        taskNumber,
        repos,
        fullyPublished: repos.length > 0 && repos.every((repo) => repo.status === "published"),
    }));
}

export function archivePublishedTasks(
    publishedTaskNumbers: number[],
    mergeResults: TaskMergeResult[],
    projectRoot: string = process.cwd(),
): { archived: number[]; leftOpen: number[] } {
    const resultsByTask = new Map(mergeResults.map((result) => [result.taskNumber, result]));
    const considered = new Set<number>([...publishedTaskNumbers, ...mergeResults.map((result) => result.taskNumber)]);

    const archived: number[] = [];
    for (const taskNumber of new Set(publishedTaskNumbers)) {
        if (resultsByTask.get(taskNumber)?.fullyPublished) archived.push(taskNumber);
    }
    const leftOpen = [...considered].filter((taskNumber) => !archived.includes(taskNumber));

    if (archived.length > 0) {
        const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
        const tasks = readTaskFile(tasksPath);
        const completedTasks = readTaskFile(completedTasksPath);
        const completionDate = new Date().toISOString().slice(0, 10);
        for (const taskNumber of archived) {
            const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
            if (index === -1) continue;
            const [task] = tasks.splice(index, 1);
            const commitHashes = (resultsByTask.get(taskNumber)?.repos ?? [])
                .filter((repo) => repo.status === "published" && repo.commitHash)
                .map((repo) => repo.commitHash as string);
            completedTasks.push({ ...task, completionDate, commitHashes });
        }
        writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
        writeFileSync(completedTasksPath, JSON.stringify(completedTasks, null, 2) + "\n");
    }

    return { archived, leftOpen };
}

```

### scripts/closeTasks.ts

```
// Moves task numbers from tasks.json to completedTasks.json with a closure note and commit hashes.
import { writeFileSync } from "node:fs";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { unblockDependents } from "./unblockDependents.ts";

export interface CloseTasksResult {
  closed: number[];
  skipped: number[];
  unblocked: number[];
}

// Local calendar date, not UTC — toISOString() rolls to tomorrow during US evening hours.
function localDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function noteFor(closureNote: string | Record<number, string>, taskNumber: number): string {
  if (typeof closureNote === "string") return closureNote;
  if (!(taskNumber in closureNote)) {
    throw new Error(`closeTasks: no closureNote given for task ${taskNumber}`);
  }
  return closureNote[taskNumber];
}

function hashesFor(
  commitHashes: string[] | Record<number, string[]>,
  taskNumber: number,
): string[] {
  if (Array.isArray(commitHashes)) return commitHashes;
  if (!(taskNumber in commitHashes)) {
    throw new Error(`closeTasks: no commitHashes given for task ${taskNumber}`);
  }
  return commitHashes[taskNumber];
}

export function closeTasks(
  taskNumbers: number[],
  closureNote: string | Record<number, string>,
  projectRoot: string = process.cwd(),
  commitHashes: string[] | Record<number, string[]> = [],
): CloseTasksResult {
  const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
  const tasks = readTaskFile(tasksPath);
  const completedTasks = readTaskFile(completedTasksPath);
  const completedNumbers = new Set(completedTasks.map((task) => task.taskNumber));
  const completionDate = localDate();

  // Duplicates would make the second findIndex return -1 and splice off an unrelated task.
  const uniqueTaskNumbers = [...new Set(taskNumbers)];

  const skipped: number[] = [];
  const willClose = uniqueTaskNumbers.filter((taskNumber) => {
    const eligible =
      tasks.some((task) => task.taskNumber === taskNumber) && !completedNumbers.has(taskNumber);
    if (!eligible) skipped.push(taskNumber);
    return eligible;
  });

  // Resolve every closing task's note/hashes before mutating anything, so a missing Record entry throws before either file is written.
  const resolved = new Map(
    willClose.map((taskNumber) => [
      taskNumber,
      { closureNote: noteFor(closureNote, taskNumber), commitHashes: hashesFor(commitHashes, taskNumber) },
    ]),
  );

  const closed: number[] = [];
  for (const taskNumber of willClose) {
    const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
    const [task] = tasks.splice(index, 1);
    const { closureNote: note, commitHashes: hashes } = resolved.get(taskNumber)!;
    completedTasks.push({ ...task, completionDate, commitHashes: hashes, closureNote: note });
    closed.push(taskNumber);
  }

  let unblocked: number[] = [];
  if (closed.length > 0) {
    unblocked = unblockDependents(tasks, closed);
    writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
    writeFileSync(completedTasksPath, JSON.stringify(completedTasks, null, 2) + "\n");
  }

  return { closed, skipped, unblocked };
}

function parseCloseNoteArg(raw: string): string | Record<number, string> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<number, string>;
    }
  } catch {
    // not JSON — treat as a plain free-text closure note
  }
  return raw;
}

function parseCommitHashesArg(raw: string | undefined): string[] | Record<number, string[]> | undefined {
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as string[]) : (parsed as Record<number, string[]>);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const taskNumbers = leadingTaskNumbers([process.argv[2] ?? ""]);
  const closureNote = parseCloseNoteArg(process.argv[3] ?? "");
  const commitHashes = parseCommitHashesArg(process.argv[4]);
  const { closed, skipped, unblocked } =
    commitHashes === undefined
      ? closeTasks(taskNumbers, closureNote)
      : closeTasks(taskNumbers, closureNote, undefined, commitHashes);
  process.stdout.write(
    `closed: ${closed.length > 0 ? closed.join(", ") : "none"}\n` +
      `skipped (already completed or not found): ${skipped.length > 0 ? skipped.join(", ") : "none"}\n` +
      (unblocked.length > 0
        ? `removed closed task(s) from blockedBy of task(s): ${unblocked.join(", ")}\n`
        : "no blockedBy references to the closed task(s)\n"),
  );
}

```

### tests/mergePipeline.test.ts

(missing: file not found on disk)

### tests/taskArchival.test.ts

```
// Behavioral checks for taskArchival.ts: only tasks explicitly listed as published, and cross-checked as fullyPublished, move from tasks.json to completedTasks.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    archivePublishedTasks,
    summarizeTaskMergeResults,
    type RawTaskRepoOutcome,
} from "../scripts/taskArchival.ts";

function makeProjectRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "taskTools-archival-"));
    writeFileSync(
        join(root, "tasks.json"),
        JSON.stringify([
            { taskNumber: 1, title: "partial rollback" },
            { taskNumber: 2, title: "fully published" },
            { taskNumber: 3, title: "conflicted" },
            { taskNumber: 4, title: "skipped" },
            { taskNumber: 5, title: "not in explicit list" },
        ]),
    );
    writeFileSync(join(root, "completedTasks.json"), "[]");
    return root;
}

function readTasks(root: string): any[] {
    return JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
}

function readCompleted(root: string): any[] {
    return JSON.parse(readFileSync(join(root, "completedTasks.json"), "utf8"));
}

test("partial-repo rollback keeps the touching task open, archives the clean one", () => {
    const root = makeProjectRoot();
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 1, repo: { repoName: "r1", status: "published", commitHash: "aaa" } },
        { taskNumber: 1, repo: { repoName: "r2", status: "rolled-back" } },
        { taskNumber: 2, repo: { repoName: "r1", status: "published", commitHash: "bbb" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    const { archived, leftOpen } = archivePublishedTasks([1, 2], mergeResults, root);

    assert.deepEqual(archived, [2]);
    assert.equal(leftOpen.includes(1), true);
    assert.equal(readTasks(root).some((t) => t.taskNumber === 1), true);
    assert.equal(readTasks(root).some((t) => t.taskNumber === 2), false);
    const completedTwo = readCompleted(root).find((t) => t.taskNumber === 2);
    assert.deepEqual(completedTwo.commitHashes, ["bbb"]);
});

test("conflicted or skipped repos keep the task open and out of completedTasks.json", () => {
    const root = makeProjectRoot();
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 3, repo: { repoName: "r1", status: "conflicted" } },
        { taskNumber: 4, repo: { repoName: "r1", status: "skipped" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    const { archived } = archivePublishedTasks([3, 4], mergeResults, root);

    assert.deepEqual(archived, []);
    assert.equal(readTasks(root).some((t) => t.taskNumber === 3), true);
    assert.equal(readTasks(root).some((t) => t.taskNumber === 4), true);
    assert.equal(readCompleted(root).length, 0);
});

test("a fully-published task not named in the explicit list stays open", () => {
    const root = makeProjectRoot();
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 5, repo: { repoName: "r1", status: "published", commitHash: "ccc" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    const { archived, leftOpen } = archivePublishedTasks([], mergeResults, root);

    assert.deepEqual(archived, []);
    assert.equal(leftOpen.includes(5), true);
    assert.equal(readTasks(root).some((t) => t.taskNumber === 5), true);
    assert.equal(readCompleted(root).length, 0);
});

test("does not import or call any approval/confirmation code path", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "scripts", "taskArchival.ts"), "utf8");
    const importLines = source.split("\n").filter((line) => line.trim().startsWith("import"));
    assert.equal(importLines.some((line) => /approvalGate|approvalReadiness/.test(line)), false);
    assert.equal(/recordApproval\(|issueApprovalAuthorization\(/.test(source), false);
});

test("commit hashes from every published repo land in completedTasks.json", () => {
    const root = makeProjectRoot();
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 2, repo: { repoName: "r1", status: "published", commitHash: "hash1" } },
        { taskNumber: 2, repo: { repoName: "r2", status: "published", commitHash: "hash2" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    archivePublishedTasks([2], mergeResults, root);

    const completedTwo = readCompleted(root).find((t) => t.taskNumber === 2);
    assert.deepEqual(completedTwo.commitHashes, ["hash1", "hash2"]);
});

test("a task with zero repos in its merge result is not fullyPublished", () => {
    const results = summarizeTaskMergeResults([]);
    assert.deepEqual(results, []);
});

test("an explicitly listed task missing from mergeResults is left open, not thrown", () => {
    const root = makeProjectRoot();
    assert.doesNotThrow(() => archivePublishedTasks([1], [], root));
    const { archived, leftOpen } = archivePublishedTasks([1], [], root);
    assert.deepEqual(archived, []);
    assert.equal(leftOpen.includes(1), true);
});

test("duplicate task numbers in publishedTaskNumbers archive the task once", () => {
    const root = makeProjectRoot();
    const raw: RawTaskRepoOutcome[] = [
        { taskNumber: 2, repo: { repoName: "r1", status: "published", commitHash: "aaa" } },
    ];
    const mergeResults = summarizeTaskMergeResults(raw);
    const { archived } = archivePublishedTasks([2, 2, 2], mergeResults, root);

    assert.deepEqual(archived, [2]);
    assert.equal(readCompleted(root).filter((t) => t.taskNumber === 2).length, 1);
});

```
