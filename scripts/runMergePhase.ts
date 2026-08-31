#!/usr/bin/env node
import { archivePublishedTasks, type ArchiveRequest, type TaskMergeResult } from "./taskArchival.ts";
import { LAP_REMAINING, LAPS_EXHAUSTED, LAP_COMPLETE, LAP_NOT_COMPLETE, ARCHIVE_REQUEST_COMPLETE, ARCHIVE_REQUEST_INCOMPLETE } from "./resultCodes.ts";
// RETIRED (task 147): unused now — see task 147 plan.
// import { execFileSync } from "node:child_process";
// import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// import { dirname, isAbsolute, join, relative, resolve } from "node:path";
// import { readCurrentRefOid } from "./basePublication.ts";
// import type { CliInput } from "./mergePipeline.ts";
// import { rebaseGroupOntoSource, type RebaseOutcome } from "./mergeTaskWorktrees.ts";
// import { generateRunId, resolveMergeScriptPath, resolveRunArgumentsPath, resolveRunOutcomesPath, resolveStepOutputsPath } from "./prepareTasks.ts";
// import type { TestReceipt } from "./approvalReadiness.ts";
// import type { RepositoryOccurrence } from "./repositoryManifest.ts";
// import { createEmptyResolutionManifest, type ResolutionManifest } from "./resolutionRequests.ts";
// import { discoverTestPolicy, type TestPolicyResult } from "./testPolicy.ts";

// RETIRED (task 147): unused now — see task 147 plan.
// export type StepOutputs = {
//     done?: unknown[];
//     partial?: unknown[];
//     blocked?: unknown[];
//     needsClarification?: unknown[];
//     requeueCount?: number;
//     testReceipts?: TestReceipt[];
//     reviewHandoffs?: string[];
// };

export type MergeFailure = { repo: string; failedCommand: string; conflicts: unknown[]; error: string };
export type MergePhaseVerdict = { status: "merged" | "blocked"; result: unknown; failure: MergeFailure | null };

// Fixed 2-lap ceiling; task 147's queue must carry it forward (see task-86-spec.md, Serial tail).
export const MAX_LAPS = 2;

export function hasLapRemaining(lapsAttempted: number): number {
    return lapsAttempted < MAX_LAPS ? LAP_REMAINING : LAPS_EXHAUSTED;
}

export type QueueStage = "rebase-test" | "merge";

export type QueueTask = {
    taskNumber: number;
    stage: QueueStage;
    lapsAttempted: number;
    lastFailure: string | null;
};

// Task 152 reports through here: the merge itself is not unwound, so this is tracked apart from `merged`.
export type MergedNotClosedTask = {
    taskNumber: number;
    commitHash: string;
    lastFailure: string;
};

// The merge (and close) succeeded; only the final worktree/branch cleanup step failed.
export type CleanupIncompleteTask = {
    taskNumber: number;
    warning: string;
    retainedArtifacts: string[];
};

// A green rebase-test committed edits outside the task's approved fence (C86-27); merge is held for re-gate.
export type PostApprovalViolation = { taskNumber: number; fenceViolations: unknown[] };

// The user rejected a post-approval regate; the cross-layer edit is already committed, so this is terminal.
export type RegateRejectedTask = { taskNumber: number; lastFailure: string };

export type MergeQueue = {
    pending: QueueTask[];
    carryover: QueueTask[];
    merged: number[];
    mergedThisLap: number;
    // A source-layer (submodule) merge that landed even though its parent later failed (C86-20).
    sourceProgressThisLap: boolean;
    unmerged: QueueTask[];
    mergedNotClosed: MergedNotClosedTask[];
    cleanupIncomplete: CleanupIncompleteTask[];
    postApprovalViolations: PostApprovalViolation[];
    regateRejected: RegateRejectedTask[];
};

export type QueueStep = { taskNumber: number; stage: QueueStage };

export type StageOutcome = { status: "success" } | { status: "failure"; reason: string; sourceProgress?: boolean };

export function createMergeQueue(): MergeQueue {
    return {
        pending: [], carryover: [], merged: [], mergedThisLap: 0, sourceProgressThisLap: false, unmerged: [],
        mergedNotClosed: [], cleanupIncomplete: [], postApprovalViolations: [], regateRejected: [],
    };
}

// An approved task enters the queue right away, at the back of the current lap's pending list.
export function enqueueApprovedTask(queue: MergeQueue, taskNumber: number): MergeQueue {
    const task: QueueTask = { taskNumber, stage: "rebase-test", lapsAttempted: 0, lastFailure: null };
    return { ...queue, pending: [...queue.pending, task] };
}

// Picks the pending stage; a task awaiting an explicit post-approval regate is never re-launched.
export function nextQueueStep(queue: MergeQueue): QueueStep | null {
    const head = queue.pending[0];
    if (!head) return null;
    if (queue.postApprovalViolations.some((violation) => violation.taskNumber === head.taskNumber)) return null;
    return { taskNumber: head.taskNumber, stage: head.stage };
}

export function currentLapIsComplete(queue: MergeQueue): number {
    return queue.pending.length === 0 ? LAP_COMPLETE : LAP_NOT_COMPLETE;
}

// "done": nothing left to retry, regardless of mergedThisLap. "stuck": zero-merge lap with recorded failures. Else "continue" (task 169).
export type QueueEndState = "continue" | "done" | "stuck";

export function shouldEndQueue(queue: MergeQueue, workflowOutstanding: boolean): QueueEndState {
    if (workflowOutstanding || currentLapIsComplete(queue) !== LAP_COMPLETE) return "continue";
    if (queue.mergedThisLap === 0 && !queue.sourceProgressThisLap && (queue.carryover.length > 0 || queue.unmerged.length > 0)) return "stuck";
    return queue.carryover.length === 0 ? "done" : "continue";
}

// tail = outstanding rebase-test/merge, serial. total/capacity share one ceiling with plan/implement (C86-24).
export type OutstandingWorkflowState = { any: boolean; tail: boolean; total: number; capacity: number };

export type QueueAction =
    | { kind: "launch"; step: QueueStep }
    | { kind: "wait" }
    | { kind: "begin-next-lap" }
    | { kind: "report"; endState: Exclude<QueueEndState, "continue"> };

export function nextQueueAction(
    queue: MergeQueue,
    outstanding: OutstandingWorkflowState,
): QueueAction {
    const step = nextQueueStep(queue);
    if (step) return (outstanding.tail || outstanding.total >= outstanding.capacity) ? { kind: "wait" } : { kind: "launch", step };

    const endState = shouldEndQueue(queue, outstanding.any);
    if (endState !== "continue") return { kind: "report", endState };
    if (queue.carryover.length > 0 && !outstanding.any) return { kind: "begin-next-lap" };
    return { kind: "wait" };
}

// Next not-yet-launched plan/implement task; tracked outside the queue until approved/enqueued.
export type ReadyLaunches = { nextPlanTask: number | null };

export type SchedulerAction =
    | { kind: "launch-plan"; taskNumber: number }
    | { kind: "launch-tail"; step: QueueStep }
    | { kind: "wait" }
    | { kind: "begin-next-lap" }
    | { kind: "report"; endState: Exclude<QueueEndState, "continue"> };

// C86-24: the one capacity decision for every launch kind. Tail wins a contested freed slot.
export function nextSchedulerAction(
    queue: MergeQueue,
    ready: ReadyLaunches,
    outstanding: OutstandingWorkflowState,
): SchedulerAction {
    const tailStep = nextQueueStep(queue);
    const tailReady = tailStep !== null && !outstanding.tail;
    const hasCapacity = outstanding.total < outstanding.capacity;

    if (hasCapacity) {
        if (tailReady) return { kind: "launch-tail", step: tailStep! };
        if (ready.nextPlanTask !== null) return { kind: "launch-plan", taskNumber: ready.nextPlanTask };
    }

    // Something is still pending though nothing launched this call: keep waiting, don't report/roll.
    if (tailStep !== null || ready.nextPlanTask !== null) return { kind: "wait" };

    const endState = shouldEndQueue(queue, outstanding.any);
    if (endState !== "continue") return { kind: "report", endState };
    if (queue.carryover.length > 0 && !outstanding.any) return { kind: "begin-next-lap" };
    return { kind: "wait" };
}

// Rotates a finished lap's carryover (failures with a lap remaining) into the next lap's pending list.
export function beginNextLap(queue: MergeQueue): MergeQueue {
    return { ...queue, pending: queue.carryover, carryover: [], mergedThisLap: 0, sourceProgressThisLap: false };
}

export function recordStageOutcome(queue: MergeQueue, taskNumber: number, stage: QueueStage, outcome: StageOutcome): MergeQueue {
    const head = queue.pending[0];
    if (!head || head.taskNumber !== taskNumber || head.stage !== stage) {
        throw new Error(`recordStageOutcome expected the queue's head to be task ${taskNumber} at stage "${stage}"`);
    }
    const rest = queue.pending.slice(1);
    if (outcome.status === "success") {
        if (stage === "rebase-test") return { ...queue, pending: [{ ...head, stage: "merge" }, ...rest] };
        return { ...queue, pending: rest, merged: [...queue.merged, taskNumber], mergedThisLap: queue.mergedThisLap + 1 };
    }
    const lapsAttempted = head.lapsAttempted + 1;
    const failed: QueueTask = { taskNumber, stage: "rebase-test", lapsAttempted, lastFailure: outcome.reason };
    const sourceProgressThisLap = queue.sourceProgressThisLap || outcome.sourceProgress === true;
    return hasLapRemaining(lapsAttempted) === LAP_REMAINING
        ? { ...queue, pending: rest, carryover: [...queue.carryover, failed], sourceProgressThisLap }
        : { ...queue, pending: rest, unmerged: [...queue.unmerged, failed], sourceProgressThisLap };
}

// Task 152 calls this when merge succeeds but archival fails; the merge stays, reported separately from unmerged.
export function recordMergedNotClosed(queue: MergeQueue, taskNumber: number, commitHash: string, lastFailure: string): MergeQueue {
    return { ...queue, mergedNotClosed: [...queue.mergedNotClosed, { taskNumber, commitHash, lastFailure }] };
}

// Merge (and close) succeeded; only final worktree/branch cleanup failed. Reported apart from unmerged (C86-28).
export function recordCleanupIncomplete(queue: MergeQueue, taskNumber: number, warning: string, retainedArtifacts: string[]): MergeQueue {
    return { ...queue, cleanupIncomplete: [...queue.cleanupIncomplete, { taskNumber, warning, retainedArtifacts }] };
}

// A cleanup-only retry (the 'cleanup-only' role) succeeded: clear the task's standing warning.
export function recordCleanupRetrySucceeded(queue: MergeQueue, taskNumber: number): MergeQueue {
    return { ...queue, cleanupIncomplete: queue.cleanupIncomplete.filter((item) => item.taskNumber !== taskNumber) };
}

// A green rebase-test carried cross-layer edits outside the fence (C86-27); holds the task at rebase-test until re-gated.
export function recordPostApprovalViolations(queue: MergeQueue, taskNumber: number, fenceViolations: unknown[]): MergeQueue {
    return {
        ...queue,
        postApprovalViolations: [...queue.postApprovalViolations.filter((v) => v.taskNumber !== taskNumber), { taskNumber, fenceViolations }],
    };
}

// A new explicit approval of the widened scope: advances the held task from rebase-test straight to merge.
export function approveRegatedTask(queue: MergeQueue, taskNumber: number): MergeQueue {
    const head = queue.pending[0];
    if (!head || head.taskNumber !== taskNumber || head.stage !== "rebase-test") {
        throw new Error(`approveRegatedTask expected the queue's head to be task ${taskNumber} at stage "rebase-test"`);
    }
    const cleared = { ...queue, postApprovalViolations: queue.postApprovalViolations.filter((v) => v.taskNumber !== taskNumber) };
    return recordStageOutcome(cleared, taskNumber, "rebase-test", { status: "success" });
}

// The widened scope was rejected: the cross-layer edit is already committed in branch history, so this is terminal.
export function rejectRegatedTask(queue: MergeQueue, taskNumber: number, reason: string): MergeQueue {
    const head = queue.pending[0];
    if (!head || head.taskNumber !== taskNumber || head.stage !== "rebase-test") {
        throw new Error(`rejectRegatedTask expected the queue's head to be task ${taskNumber} at stage "rebase-test"`);
    }
    return {
        ...queue,
        pending: queue.pending.slice(1),
        postApprovalViolations: queue.postApprovalViolations.filter((v) => v.taskNumber !== taskNumber),
        regateRejected: [...queue.regateRejected, { taskNumber, lastFailure: reason }],
    };
}

export type TerminalReason = "2-lap ceiling reached" | "zero-merge lap ended the queue";

export type UnmergedTaskReport = {
    taskNumber: number;
    lastFailure: string;
    terminalReason: TerminalReason;
};

export type MergeReport = {
    unmerged: UnmergedTaskReport[];
    mergedNotClosed: MergedNotClosedTask[];
    cleanupIncomplete: CleanupIncompleteTask[];
    regateRejected: RegateRejectedTask[];
};

// Reports queue.unmerged (hit the ceiling) and queue.carryover (retryable when the queue ended early); both left pending, unmerged.
export function buildMergeReport(queue: MergeQueue): MergeReport {
    const ceilingFailures: UnmergedTaskReport[] = queue.unmerged.map((task): UnmergedTaskReport => ({
        taskNumber: task.taskNumber,
        lastFailure: task.lastFailure as string,
        terminalReason: "2-lap ceiling reached",
    }));
    const queueExitFailures: UnmergedTaskReport[] = queue.carryover.map((task): UnmergedTaskReport => ({
        taskNumber: task.taskNumber,
        lastFailure: task.lastFailure as string,
        terminalReason: "zero-merge lap ended the queue",
    }));
    return {
        unmerged: [...ceilingFailures, ...queueExitFailures],
        mergedNotClosed: queue.mergedNotClosed,
        cleanupIncomplete: queue.cleanupIncomplete,
        regateRejected: queue.regateRejected,
    };
}

type JsonObject = Record<string, unknown>;

export type TaskWorkflowEnvelope = {
    task: number;
    stage: "plan+implement" | "rebase-test" | "merge";
    results: JsonObject[];
};

export type ApprovalView = {
    taskNumber: number;
    status: string;
    verifier: JsonObject | null;
    fenceViolations: unknown[];
};

export type RegateView = { taskNumber: number; fenceViolations: unknown[] };

export type ConsumedWorkflowResult =
    | { kind: "approval"; queue: MergeQueue; approval: ApprovalView }
    | { kind: "queue"; queue: MergeQueue; taskNumber: number; stage: QueueStage; status: string }
    | { kind: "requires-regate"; queue: MergeQueue; approval: RegateView };

function objectAt(results: unknown[], index: number, label: string): JsonObject {
    const value = results[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`task workflow envelope has no ${label} result at results[${index}]`);
    }
    return value as JsonObject;
}

function nonemptyString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value;
}

// The one place that decodes a task-workflow completion notification. Callers never index results[] themselves.
export function consumeTaskWorkflowResult(
    queue: MergeQueue,
    envelope: TaskWorkflowEnvelope,
): ConsumedWorkflowResult {
    if (envelope.stage === "plan+implement") {
        const plan = objectAt(envelope.results, 0, "plan");
        const implement = envelope.results.length > 1
            ? objectAt(envelope.results, 1, "implement")
            : null;
        return {
            kind: "approval",
            queue,
            approval: {
                taskNumber: envelope.task,
                status: String(implement?.status ?? plan.status),
                verifier: plan.verify && typeof plan.verify === "object"
                    ? plan.verify as JsonObject
                    : null,
                fenceViolations: Array.isArray(implement?.fenceViolations)
                    ? implement!.fenceViolations
                    : [],
            },
        };
    }

    const result = objectAt(envelope.results, 0, envelope.stage);
    const status = nonemptyString(result.status, `${envelope.stage}.status`);

    // C86-27: a green rebase-test that also carried cross-layer edits must not advance to merge un-gated.
    if (envelope.stage === "rebase-test" && status === "green" && Array.isArray(result.fenceViolations) && result.fenceViolations.length > 0) {
        return {
            kind: "requires-regate",
            queue: recordPostApprovalViolations(queue, envelope.task, result.fenceViolations),
            approval: { taskNumber: envelope.task, fenceViolations: result.fenceViolations },
        };
    }

    const success = envelope.stage === "rebase-test"
        ? status === "green"
        : status === "merged" || status === "merged-but-not-closed" || status === "cleanup-incomplete";
    // C86-20: a failed deepest-first merge may still have landed a source (submodule) layer before its parent failed.
    const sourceProgress = envelope.stage === "merge" && Array.isArray(result.completedLayers)
        && result.completedLayers.some((layer) => !!layer && typeof layer === "object" && (layer as JsonObject).status === "merged");
    const outcome: StageOutcome = success
        ? { status: "success" }
        : {
            status: "failure",
            reason: nonemptyString(result.lastFailure, `${envelope.stage}.lastFailure`),
            sourceProgress,
        };

    let next = recordStageOutcome(queue, envelope.task, envelope.stage, outcome);
    if (envelope.stage === "merge" && status === "merged-but-not-closed") {
        next = recordMergedNotClosed(
            next,
            envelope.task,
            nonemptyString(result.mergedCommitHash, "merge.mergedCommitHash"),
            nonemptyString(result.closeError, "merge.closeError"),
        );
    }
    if (envelope.stage === "merge" && typeof result.cleanupWarning === "string" && result.cleanupWarning.length > 0) {
        next = recordCleanupIncomplete(
            next,
            envelope.task,
            result.cleanupWarning,
            Array.isArray(result.retainedArtifacts) ? result.retainedArtifacts as string[] : [],
        );
    }
    return { kind: "queue", queue: next, taskNumber: envelope.task, stage: envelope.stage, status };
}

export type CleanupRetryEnvelope = {
    task: number;
    stage: "cleanup-only";
    results: JsonObject[];
};

// Decodes a 'cleanup-only' completion; the task already left pending/merged, so only cleanupIncomplete moves.
export function consumeCleanupRetryResult(queue: MergeQueue, envelope: CleanupRetryEnvelope): MergeQueue {
    const result = objectAt(envelope.results, 0, "cleanup-only");
    const status = nonemptyString(result.status, "cleanup-only.status");
    return status === "cleaned" ? recordCleanupRetrySucceeded(queue, envelope.task) : queue;
}

// RETIRED (task 147): derived run-outcomes.json's aggregate counts from one batch's StepOutputs arrays.  The serial queue merges and fails one task at a time; MergeQueue.merged and MergeQueue.unmerged above hold the per-task record directly, so there is no batch array left to aggregate.  export function buildMergeOutcomes(steps: StepOutputs) { return { doneCount: steps.done?.length ?? 0, partialCount: steps.partial?.length ?? 0, blockedCount: steps.blocked?.length ?? 0, needsClarificationCount: steps.needsClarification?.length ?? 0, requeueCount: steps.requeueCount ?? 0, testReceipts: steps.testReceipts ?? [], reviewHandoffs: steps.reviewHandoffs ?? [], }; }

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

// RETIRED (task 147): shelled out to run the batch merge script and the post-rebase test commands for coordinateMergeRetry's retry path. Nothing in the serial queue launches a process — that belongs to the rebase-test and merge stages of task.workflow.js (tasks 145/146 and 150-152).  function runScript(command: string[], cwd?: string): ScriptRun { try { return { exitCode: 0, stdout: execFileSync(command[0]!, command.slice(1), { encoding: "utf8", cwd }), stderr: "" }; } catch (error) { const failed = error as { status?: number; stdout?: string; stderr?: string }; return { exitCode: failed.status ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" }; } }

function blockedVerdict(repo: string, failedCommand: string, error: string): MergePhaseVerdict {
    return { status: "blocked", result: null, failure: { repo, failedCommand, conflicts: [], error } };
}

function isArchiveRequest(value: unknown): value is ArchiveRequest {
    const request = value as Partial<ArchiveRequest> | null | undefined;
    return !!request && Array.isArray(request.publishedTaskNumbers) && Array.isArray(request.mergeResults);
}

// Requires the flag, at least one repo, and every repo published with a commit hash.
function isFullyPublishable(result: TaskMergeResult | undefined): result is TaskMergeResult {
    return !!result
        && result.fullyPublished
        && result.repos.length > 0
        && result.repos.every((repo) => repo.status === "published" && !!repo.commitHash);
}

// Every uniquely-requested task must resolve to exactly one fully-publishable mergeResult before archival is even attempted.
function archiveRequestIsComplete(request: ArchiveRequest): number {
    for (const taskNumber of new Set(request.publishedTaskNumbers)) {
        const matches = request.mergeResults.filter((result) => result.taskNumber === taskNumber);
        if (matches.length !== 1 || !isFullyPublishable(matches[0])) return ARCHIVE_REQUEST_INCOMPLETE;
    }
    return ARCHIVE_REQUEST_COMPLETE;
}

export function archiveIfMerged(
    verdict: MergePhaseVerdict,
    repo: string,
    failedCommand: string,
    archive: typeof archivePublishedTasks,
): MergePhaseVerdict {
    if (verdict.status !== "merged") return verdict;
    const archiveRequest = (verdict.result as { archiveRequest?: unknown } | null)?.archiveRequest;
    if (!isArchiveRequest(archiveRequest) || archiveRequestIsComplete(archiveRequest) !== ARCHIVE_REQUEST_COMPLETE) {
        return blockedVerdict(repo, failedCommand, "merge script reported a merged verdict with no valid, complete archiveRequest; refusing to archive");
    }
    try {
        const { archived, leftOpen } = archive(archiveRequest.publishedTaskNumbers, archiveRequest.mergeResults, repo);
        const requested = new Set(archiveRequest.publishedTaskNumbers);
        const archivedSet = new Set(archived);
        const archivedEverything = requested.size === archivedSet.size && [...requested].every((taskNumber) => archivedSet.has(taskNumber));
        const noneLeftOpen = [...requested].every((taskNumber) => !leftOpen.includes(taskNumber));
        if (!archivedEverything || !noneLeftOpen) {
            return blockedVerdict(repo, failedCommand, `archival reported an incomplete result: archived [${archived.join(", ")}], leftOpen [${leftOpen.join(", ")}], requested [${[...requested].join(", ")}]`);
        }
        return verdict;
    } catch (error) {
        return blockedVerdict(repo, failedCommand, `archival failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// RETIRED (task 147): detected "the source branch moved past the pinned baseOid" so a batch retry could recover. The serial queue rebases each task onto the current tip on every lap (task 145/146's rebase-test stage), so a source branch moving out from under a pending merge can no longer happen.  function resultIndicatesBaseDrift(verdict: MergePhaseVerdict): boolean { const result = verdict.result as { abortReason?: string | null } | null; return typeof result?.abortReason === "string" && result.abortReason.startsWith("the source branch moved past the pinned baseOid"); }

// function confirmedBaseDrift(verdict: MergePhaseVerdict): boolean { return verdict.status === "blocked" && resultIndicatesBaseDrift(verdict); }

// RETIRED (task 147): private helpers used only inside coordinateMergeRetry's batch-retry path below — describing a rebase failure, locating an occurrence inside a worktree, and minting a fresh run ID with rewritten operation branches so a retried batch push did not collide with the run it was retrying.  function describeRebaseFailure(outcome: RebaseOutcome): string { if (outcome.status === "conflicted") return `rebase conflicted: ${outcome.conflictedFilePaths.join(", ")}`; if (outcome.status === "cleanup-failed") return outcome.failureReason; return "rebase reported unexpected clean status while being treated as a failure"; }

// function occurrencePathInWorktree(repoRoot: string, worktree: string, checkoutPath: string): string { const absoluteCheckout = isAbsolute(checkoutPath) ? checkoutPath : join(repoRoot, checkoutPath); const relativePath = relative(resolve(repoRoot), absoluteCheckout); return relativePath === "" || relativePath === "." ? worktree : join(worktree, relativePath); }

// function mintFreshRunId(generate: () => string, oldRunId: string): string { const candidate = generate(); return candidate === oldRunId ? `${candidate}-retry` : candidate; }

// function rewriteOperationBranches( occurrences: RepositoryOccurrence[], oldRunId: string, newRunId: string, ): RepositoryOccurrence[] | null { const oldPrefix = `operations/${oldRunId}/`; const rewritten: RepositoryOccurrence[] = []; for (const occurrence of occurrences) { if (!occurrence.operationBranch.startsWith(oldPrefix)) return null; rewritten.push({ ...occurrence, operationBranch: `operations/${newRunId}/${occurrence.operationBranch.slice(oldPrefix.length)}` }); } return rewritten; }

// RETIRED (task 147): refreshed each occurrence's baseOid from the live ref before a batch retry re-ran the merge script. The serial queue never re-runs a merge script against a stale baseOid — each task's rebase-test stage already rebased onto the current tip immediately before its merge stage runs.  function refreshBaseOids( repoRoot: string, occurrences: RepositoryOccurrence[], readRefOid: (repoRoot: string, ref: string) => string | null, ): RepositoryOccurrence[] | null { const refreshed: RepositoryOccurrence[] = []; for (const occurrence of occurrences) { const checkoutRoot = isAbsolute(occurrence.checkoutPath) ? occurrence.checkoutPath : join(repoRoot, occurrence.checkoutPath); const oid = readRefOid(checkoutRoot, `refs/heads/${occurrence.baseBranch}`); if (oid === null) return null; refreshed.push({ ...occurrence, baseOid: oid }); } return refreshed; }

// RETIRED (task 147): coordinateMergeRetry rebased and re-tested every group in one batch, minted a
// fresh run ID, rewrote operation branches, refreshed base OIDs, and re-ran the whole batch merge script
// once on confirmed base drift. The serial queue's rebase-test stage (task 145/146) already rebases each
// task onto the current tip every lap, and its merge stage (task 150-152) merges one task at a time —
// there is no batch base-drift condition left for this to recover from. MergeRetryDeps only existed to
// type coordinateMergeRetry's injected dependencies and retires with it.
// export type MergeRetryDeps = {
//     runScript: (command: string[], cwd?: string) => ScriptRun;
//     generateRunId: () => string;
//     readRefOid: (repoRoot: string, ref: string) => string | null;
//     writeRunArguments: (data: unknown) => void;
//     rebaseGroupOntoSource: (worktreePath: string, sourceBranch: string) => RebaseOutcome;
//     discoverTestPolicy: (occurrenceId: string, checkoutPath: string, resolutionManifest: ResolutionManifest) => TestPolicyResult;
// };

// export function coordinateMergeRetry( runArguments: CliInput, mergeCommand: string[], deps: MergeRetryDeps, ): MergePhaseVerdict { const sourceBranch = runArguments.repositorySources.find((source) => source.path === "")?.sourceBranch; if (!sourceBranch) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "no recorded source branch for repository root"); for (const group of runArguments.groups) { const rebaseOutcome = deps.rebaseGroupOntoSource(group.worktree, sourceBranch); if (rebaseOutcome.status !== "rebased-clean") { return blockedVerdict(runArguments.repo, mergeCommand.join(" "), describeRebaseFailure(rebaseOutcome)); } for (const occurrence of runArguments.repositoryManifest.occurrences) { const occurrencePath = occurrencePathInWorktree(runArguments.repo, group.worktree, occurrence.checkoutPath); const policyResult = deps.discoverTestPolicy(occurrence.occurrenceId, occurrencePath, createEmptyResolutionManifest()); if (policyResult.status !== "resolved") { return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `test policy unresolved for occurrence "${occurrence.occurrenceId}"`); } const testRun = deps.runScript(["sh", "-c", policyResult.policy.completeSuiteCommand], occurrencePath); if (testRun.exitCode !== 0) { return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `post-rebase tests failed for occurrence "${occurrence.occurrenceId}": ${testRun.stderr || testRun.stdout}`); } } } const oldRunId = runArguments.runId; if (!oldRunId) return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "run arguments carry no runId to retry from"); const newRunId = mintFreshRunId(deps.generateRunId, oldRunId); const rewrittenOccurrences = rewriteOperationBranches(runArguments.repositoryManifest.occurrences, oldRunId, newRunId); if (rewrittenOccurrences === null) { return blockedVerdict(runArguments.repo, mergeCommand.join(" "), `an occurrence operationBranch does not carry the expected prefix "operations/${oldRunId}/"`); } const refreshedOccurrences = refreshBaseOids(runArguments.repo, rewrittenOccurrences, deps.readRefOid); if (refreshedOccurrences === null) { return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "failed to read a refreshed base OID for an occurrence"); } const updatedArguments: CliInput = { ...runArguments, runId: newRunId, repositoryManifest: { ...runArguments.repositoryManifest, occurrences: refreshedOccurrences }, }; deps.writeRunArguments(updatedArguments); const retryVerdict = judgeMergeRun(deps.runScript(mergeCommand), runArguments.repo, mergeCommand.join(" ")); if (resultIndicatesBaseDrift(retryVerdict)) { return blockedVerdict(runArguments.repo, mergeCommand.join(" "), "retry hit a second base-drift result; no further attempt"); } return retryVerdict; }

// RETIRED (task 147): retried once, only on a confirmed base-drift verdict from the batch merge script.  confirmedBaseDrift (above) can never be true once coordinateMergeRetry is gone, so this has nothing left to trigger it.  export function resolveMergeVerdict( initialVerdict: MergePhaseVerdict, readRunArguments: () => CliInput, mergeCommand: string[], deps: MergeRetryDeps, ): MergePhaseVerdict { if (!confirmedBaseDrift(initialVerdict)) return initialVerdict; // Re-read only here: a successful merge deletes run-arguments.json, so an unconditional read would throw.  return coordinateMergeRetry(readRunArguments(), mergeCommand, deps); }

// RETIRED (task 147): the aggregated stepOutputsFile plumbing. runAsCli was the batch model's single CLI entrypoint: it read the whole run's step outputs from run-steps.json (resolveStepOutputsPath), wrote run-outcomes.json (resolveRunOutcomesPath) via buildMergeOutcomes, ran mergeTaskWorktrees.ts once over every group (resolveMergeScriptPath), and retried it via resolveMergeVerdict. The serial queue above is a set of pure functions consumed by direct import (task.workflow.js and its stages, tasks 150-152) — nothing launches this file as a subprocess any more, so there is no CLI entrypoint left to keep.  function runAsCli(): void { const repoRoot = process.cwd(); const stepsFile = resolveStepOutputsPath(repoRoot); if (!existsSync(stepsFile)) throw new Error(`no step outputs at "${stepsFile}"; write them there before running the merge phase`); const outcomesFile = resolveRunOutcomesPath(repoRoot); mkdirSync(dirname(outcomesFile), { recursive: true }); writeFileSync(outcomesFile, JSON.stringify(buildMergeOutcomes(JSON.parse(readFileSync(stepsFile, "utf8"))))); const runArgumentsPath = resolveRunArgumentsPath(repoRoot); const command = ["node", "--no-inspect", resolveMergeScriptPath(), "--run", runArgumentsPath, outcomesFile]; const deps: MergeRetryDeps = { runScript, generateRunId, readRefOid: readCurrentRefOid, writeRunArguments: (data) => writeFileSync(runArgumentsPath, JSON.stringify(data)), rebaseGroupOntoSource, discoverTestPolicy, }; const initialVerdict = judgeMergeRun(runScript(command), repoRoot, command.join(" ")); const verdict = resolveMergeVerdict( initialVerdict, () => JSON.parse(readFileSync(runArgumentsPath, "utf8")), command, deps, ); const finalVerdict = archiveIfMerged(verdict, repoRoot, command.join(" "), archivePublishedTasks); process.stdout.write(JSON.stringify(finalVerdict)); }

// if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
