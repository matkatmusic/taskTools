// Implements pipeline.mmd's lock-then-rebase step: acquires the re-entrant source lock (rule 9), rebases every layer deepest-first with conflict markers.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
    acquireSourceRepoLock, buildLockOwner, refreshOwnedSourceRepoLockOrThrow, releaseSourceRepoLock,
} from "./sourceRepoLock.ts";
import { formatSourceRepoLockRecoveryCommand } from "./recoverSourceRepoLock.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { buildDiscoveryManifest, buildWorktreeOccurrences, rebaseWorktreeSubmoduleLayersDeepestFirst } from "./occurrences.ts";
import { createEmptyResolutionManifest } from "../../resolutionRequests.ts";
import {
    appendStepResult, updateCurrentTaskRun, type RebaseStepReceipt, type SourceTipReceipt,
} from "./taskRunState.ts";
import {
    rebaseParentOntoSourceAndTest,
    type ParentRebaseOutcome, type SubmoduleLayerOutcome,
} from "../../mergeTaskWorktrees.ts";

export type RebaseTaskWorktreeInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    stepId: string;
    rootSourceBranch: string;
};

// F3: proof the merge box merges rebase's exact tip; persisted on the run record for lost-stdout reconciliation to recover.
export type { RebaseStepReceipt, SourceTipReceipt } from "./taskRunState.ts";

export type RebaseTaskWorktreeOutput = {
    lock: "acquired" | "held" | "recoverable";
    heldByOwner: string | null;
    recoveryCommand: string | null;
    conflicted: boolean;
    stoppedAt: { occurrenceId: string; checkoutPath: string } | null;
    conflictedFilePaths: string[];
    failureReason: string | null;
};

const POLL_INTERVAL_MS = 10_000;
const WAIT_TIMEOUT_MS = 2 * 60_000;

export type BoundedLockWaitOptions = {
    pollIntervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    nowMs?: () => number;
};

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-entrant for the same owner; bounded polling, never blocks forever; returns held or recoverable, never fails (rule 9).
export async function acquireSourceRepoLockBounded(
    projectRoot: string,
    owner: string,
    options: BoundedLockWaitOptions = {},
): Promise<{ lock: "acquired" | "held" | "recoverable"; heldByOwner: string | null }> {
    const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? WAIT_TIMEOUT_MS;
    const sleep = options.sleep ?? defaultSleep;
    const now = options.nowMs ?? Date.now;
    const deadline = now() + timeoutMs;

    while (true) {
        const outcome = acquireSourceRepoLock(projectRoot, owner);
        if (outcome.status === "acquired" || outcome.status === "already-held-by-me") {
            return { lock: "acquired", heldByOwner: null };
        }
        if (outcome.status === "recoverable") {
            return { lock: "recoverable", heldByOwner: outcome.owner };
        }
        if (now() >= deadline) {
            return { lock: "held", heldByOwner: outcome.owner };
        }
        await sleep(pollIntervalMs);
    }
}

function directChildPathsInParent(manifest: ReturnType<typeof buildDiscoveryManifest>): string[] {
    return manifest.repositoryManifest.occurrences
        .filter((occurrence) => occurrence.parentOccurrenceId === "")
        .map((occurrence) => occurrence.pathInParent)
        .filter((path): path is string => path !== null);
}

// F3: reads the live source manifest; run after the source lock is held. Captures baseBranch/sourceTip per occurrence for verification.
export function captureSourceTipReceipts(worktreePath: string, projectRoot: string, rootSourceBranch: string): SourceTipReceipt[] {
    const rootTip = execFileSync("git", ["-C", projectRoot, "rev-parse", rootSourceBranch], { encoding: "utf8" }).trim();
    const receipts: SourceTipReceipt[] = [{ occurrenceId: "", baseBranch: rootSourceBranch, sourceTip: rootTip }];
    for (const occurrence of buildWorktreeOccurrences(worktreePath, projectRoot, rootSourceBranch)) {
        if (occurrence.occurrenceId === "") continue;
        const sourceTip = execFileSync(
            "git", ["-C", occurrence.sourceCheckoutPath, "rev-parse", occurrence.baseBranch], { encoding: "utf8" },
        ).trim();
        receipts.push({ occurrenceId: occurrence.occurrenceId, baseBranch: occurrence.baseBranch, sourceTip });
    }
    return receipts;
}

// F3: each worktree layer's HEAD after the step finished; paired with occurrence set walked, lets reconciliation spot stale receipts.
function captureWorktreeHeadReceipts(worktreePath: string, projectRoot: string, rootSourceBranch: string): { occurrenceId: string; head: string }[] {
    return buildWorktreeOccurrences(worktreePath, projectRoot, rootSourceBranch).map((occurrence) => ({
        occurrenceId: occurrence.occurrenceId,
        head: execFileSync("git", ["-C", occurrence.worktreeCheckoutPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    }));
}

// F3: durable evidence for every outcome, not just clean finishes; occurrenceIds/worktreeHeads captured with result so reconciliation spots stale receipts.
export function persistRebaseStepResult(
    taskNumber: number, runId: string, stepId: string, script: string, worktreePath: string, projectRoot: string,
    rootSourceBranch: string, result: Record<string, unknown>,
): void {
    const worktreeHeads = captureWorktreeHeadReceipts(worktreePath, projectRoot, rootSourceBranch);
    appendStepResult(taskNumber, runId, {
        stepId, script, result,
        occurrenceIds: worktreeHeads.map((entry) => entry.occurrenceId).sort(),
        worktreeHeads,
    }, projectRoot);
}

export function persistSourceTipReceipts(
    taskNumber: number, runId: string, stepId: string, worktreePath: string, projectRoot: string, rootSourceBranch: string, receipts: SourceTipReceipt[],
): void {
    const worktreeHeads = captureWorktreeHeadReceipts(worktreePath, projectRoot, rootSourceBranch);
    const rebaseStepReceipt: RebaseStepReceipt = {
        stepId,
        occurrenceIds: worktreeHeads.map((entry) => entry.occurrenceId).sort(),
        worktreeHeads,
        sourceTips: receipts,
    };
    updateCurrentTaskRun(taskNumber, runId, { sourceTipsAtRebase: receipts, rebaseStepReceipt }, projectRoot);
}

function mapSubmoduleStop(stoppedAt: SubmoduleLayerOutcome): Omit<RebaseTaskWorktreeOutput, "lock" | "heldByOwner" | "recoveryCommand"> {
    const stoppedAtField = { occurrenceId: stoppedAt.occurrenceId, checkoutPath: stoppedAt.checkoutPath };
    if (stoppedAt.status === "conflicted") {
        return { conflicted: true, stoppedAt: stoppedAtField, conflictedFilePaths: stoppedAt.conflictedFilePaths, failureReason: null };
    }
    if (stoppedAt.status === "tests-failed") {
        return { conflicted: false, stoppedAt: stoppedAtField, conflictedFilePaths: [], failureReason: `${stoppedAt.failedCheck}: ${stoppedAt.testOutput}` };
    }
    // cleanup-failed, source-sync-failed, untested: operational failure -> run-failed.
    const reason = "failureReason" in stoppedAt
        ? stoppedAt.failureReason
        : `test policy needs resolution for "${stoppedAt.occurrenceId}"`;
    throw new Error(`rebase of occurrence "${stoppedAt.occurrenceId}" failed operationally: ${reason}`);
}

function mapParentOutcome(worktreePath: string, outcome: ParentRebaseOutcome): Omit<RebaseTaskWorktreeOutput, "lock" | "heldByOwner" | "recoveryCommand"> {
    const stoppedAtField = { occurrenceId: "", checkoutPath: worktreePath };
    if (outcome.status === "conflicted") {
        return { conflicted: true, stoppedAt: stoppedAtField, conflictedFilePaths: outcome.conflictedFilePaths, failureReason: null };
    }
    if (outcome.status === "tests-failed") {
        return { conflicted: false, stoppedAt: stoppedAtField, conflictedFilePaths: [], failureReason: `${outcome.failedCheck}: ${outcome.testOutput}` };
    }
    if (outcome.status === "rebased") {
        return { conflicted: false, stoppedAt: null, conflictedFilePaths: [], failureReason: null };
    }
    if (outcome.status === "rebased-and-tested") {
        return { conflicted: false, stoppedAt: null, conflictedFilePaths: [], failureReason: null };
    }
    const reason = outcome.status === "untested" ? "test policy needs resolution for root" : outcome.failureReason;
    throw new Error(`rebase of the root occurrence failed operationally: ${reason}`);
}

export async function rebaseTaskWorktree(
    input: RebaseTaskWorktreeInput,
    lockOptions: BoundedLockWaitOptions = {},
): Promise<RebaseTaskWorktreeOutput> {
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const worktreePath = requireAbsolutePath("worktreePath", input.worktreePath);
    const owner = buildLockOwner(input.runId, input.taskNumber);
    const acquireResult = await acquireSourceRepoLockBounded(projectRoot, owner, lockOptions);
    if (acquireResult.lock !== "acquired") {
        return {
            lock: acquireResult.lock,
            heldByOwner: acquireResult.heldByOwner,
            recoveryCommand: acquireResult.lock === "recoverable"
                ? formatSourceRepoLockRecoveryCommand(projectRoot, acquireResult.heldByOwner!)
                : null,
            conflicted: false, stoppedAt: null, conflictedFilePaths: [], failureReason: null,
        };
    }
    try {
        refreshOwnedSourceRepoLockOrThrow(projectRoot, owner);

        // Rebase only: pipeline-rebase.mmd runs no tests; pipeline-suite.mmd runs the suite afterwards.
        const submoduleReport = rebaseWorktreeSubmoduleLayersDeepestFirst(worktreePath, projectRoot, input.taskNumber, input.rootSourceBranch, true, null, false);
        if (submoduleReport.stoppedAt !== null) {
            const result: RebaseTaskWorktreeOutput = {
                lock: "acquired", heldByOwner: null, recoveryCommand: null, ...mapSubmoduleStop(submoduleReport.stoppedAt),
            };
            persistRebaseStepResult(input.taskNumber, input.runId, input.stepId, "rebaseTaskWorktree", worktreePath, projectRoot, input.rootSourceBranch, result);
            return result;
        }

        const manifest = buildDiscoveryManifest(worktreePath, projectRoot, input.rootSourceBranch);
        const parentOutcome = rebaseParentOntoSourceAndTest(
            "",
            worktreePath,
            input.rootSourceBranch,
            directChildPathsInParent(manifest),
            createEmptyResolutionManifest(),
            true,
            null,
            false,
        );
        const mapped = mapParentOutcome(worktreePath, parentOutcome);
        if (mapped.stoppedAt === null && mapped.failureReason === null) {
            const receipts = captureSourceTipReceipts(worktreePath, projectRoot, input.rootSourceBranch);
            persistSourceTipReceipts(input.taskNumber, input.runId, input.stepId, worktreePath, projectRoot, input.rootSourceBranch, receipts);
        }
        const result: RebaseTaskWorktreeOutput = { lock: "acquired", heldByOwner: null, recoveryCommand: null, ...mapped };
        persistRebaseStepResult(input.taskNumber, input.runId, input.stepId, "rebaseTaskWorktree", worktreePath, projectRoot, input.rootSourceBranch, result);
        return result;
    } catch (error) {
        // Every operational throw here (mapSubmoduleStop/mapParentOutcome's default branches, or
        // any git call above) leaves the lock held unless released here. The deliberate
        // "conflicted" status returns normally above and never reaches this catch, so
        // FIX_CONFLICTS still finds the lock held, as intended. releaseSourceRepoLock reproves
        // ownership itself, so calling it unconditionally is always safe (matches
        // cleanupTaskWorktree.ts's existing catch-then-release precedent).
        releaseSourceRepoLock(projectRoot, owner);
        throw error;
    }
}

if (process.argv[1]?.endsWith("rebaseTaskWorktree.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as RebaseTaskWorktreeInput;
    rebaseTaskWorktree(input).then((output) => {
        process.stdout.write(`${JSON.stringify(output)}\n`);
    }).catch((error) => {
        process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
        process.exitCode = 1;
    });
}
