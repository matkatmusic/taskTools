// "lock the source repo, then rebase onto the target branch" + "did the rebase report
// conflicts?" (pipeline.mmd). Acquires the source-repo lock (re-entrant for the same owner,
// bounded wait per rule 9), then rebases every layer deepest-first with live conflict markers.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
    acquireSourceRepoLock, buildLockOwner, refreshOwnedSourceRepoLockOrThrow,
} from "./sourceRepoLock.ts";
import { formatSourceRepoLockRecoveryCommand } from "./recoverSourceRepoLock.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { buildDiscoveryManifest, buildWorktreeOccurrences, rebaseWorktreeSubmoduleLayersDeepestFirst } from "./occurrences.ts";
import { createEmptyResolutionManifest } from "../resolutionRequests.ts";
import {
    appendStepResult, updateCurrentTaskRun, type RebaseStepReceipt, type SourceTipReceipt,
} from "./taskRunState.ts";
import {
    rebaseParentOntoSourceAndTest,
    type ParentRebaseOutcome, type SubmoduleLayerOutcome,
} from "../mergeTaskWorktrees.ts";

export type RebaseTaskWorktreeInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    stepId: string;
    rootSourceBranch: string;
};

// F3: the merge box's proof that it merges the exact tip rebase left. Persisted onto the
// current run record (see mergeTaskWorktree.ts's verification) so a lost-stdout reconciliation
// can still recover it.
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

const POLL_INTERVAL_MS = 5_000;
const WAIT_TIMEOUT_MS = 15 * 60_000;

export type BoundedLockWaitOptions = {
    pollIntervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    nowMs?: () => number;
};

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-entrant for the same owner (already-held-by-me is a no-op). Bounded: polls, never blocks
// forever. Returns "held" (warm) or "recoverable" (cold) instead of failing (rule 9, [a3 24]).
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

// F3: reads the live source manifest via buildWorktreeOccurrences, so it must run after the
// source lock is held/refreshed. Captures root plus every source occurrence's {baseBranch,
// sourceTip} exactly as the rebase left it, for mergeTaskWorktree.ts to verify unchanged.
export function captureSourceTipReceipts(worktreePath: string, projectRoot: string, rootSourceBranch: string): SourceTipReceipt[] {
    const rootTip = execFileSync("git", ["-C", projectRoot, "rev-parse", rootSourceBranch], { encoding: "utf8" }).trim();
    const receipts: SourceTipReceipt[] = [{ occurrenceId: "", baseBranch: rootSourceBranch, sourceTip: rootTip }];
    for (const occurrence of buildWorktreeOccurrences(worktreePath, projectRoot)) {
        if (occurrence.occurrenceId === "") continue;
        const sourceTip = execFileSync(
            "git", ["-C", occurrence.sourceCheckoutPath, "rev-parse", occurrence.baseBranch], { encoding: "utf8" },
        ).trim();
        receipts.push({ occurrenceId: occurrence.occurrenceId, baseBranch: occurrence.baseBranch, sourceTip });
    }
    return receipts;
}

// F3: every worktree layer's HEAD right after the step finished. Paired with the exact
// occurrence set it walked, this is what lets reconciliation tell "this step's own evidence"
// from a stale receipt a prior visit left behind.
function captureWorktreeHeadReceipts(worktreePath: string, projectRoot: string): { occurrenceId: string; head: string }[] {
    return buildWorktreeOccurrences(worktreePath, projectRoot).map((occurrence) => ({
        occurrenceId: occurrence.occurrenceId,
        head: execFileSync("git", ["-C", occurrence.worktreeCheckoutPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    }));
}

// F3: durable evidence for EVERY returned outcome of rebaseTaskWorktree/advanceTaskRebase, not
// just a clean finish — a conflict or test failure is just as much a real result that must be
// reconstructable. `occurrenceIds`/`worktreeHeads` are captured at the same moment as `result`,
// so reconciliation can tell a still-live receipt from one the world has since moved past.
export function persistRebaseStepResult(
    taskNumber: number, runId: string, stepId: string, script: string, worktreePath: string, projectRoot: string,
    result: Record<string, unknown>,
): void {
    const worktreeHeads = captureWorktreeHeadReceipts(worktreePath, projectRoot);
    appendStepResult(taskNumber, runId, {
        stepId, script, result,
        occurrenceIds: worktreeHeads.map((entry) => entry.occurrenceId).sort(),
        worktreeHeads,
    }, projectRoot);
}

export function persistSourceTipReceipts(
    taskNumber: number, runId: string, stepId: string, worktreePath: string, projectRoot: string, receipts: SourceTipReceipt[],
): void {
    const worktreeHeads = captureWorktreeHeadReceipts(worktreePath, projectRoot);
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
    refreshOwnedSourceRepoLockOrThrow(projectRoot, owner);

    const submoduleReport = rebaseWorktreeSubmoduleLayersDeepestFirst(worktreePath, projectRoot, input.taskNumber, true, null);
    if (submoduleReport.stoppedAt !== null) {
        const result: RebaseTaskWorktreeOutput = {
            lock: "acquired", heldByOwner: null, recoveryCommand: null, ...mapSubmoduleStop(submoduleReport.stoppedAt),
        };
        persistRebaseStepResult(input.taskNumber, input.runId, input.stepId, "rebaseTaskWorktree", worktreePath, projectRoot, result);
        return result;
    }

    const manifest = buildDiscoveryManifest(worktreePath, projectRoot);
    const parentOutcome = rebaseParentOntoSourceAndTest(
        "",
        worktreePath,
        input.rootSourceBranch,
        directChildPathsInParent(manifest),
        createEmptyResolutionManifest(),
        true,
        null,
    );
    const mapped = mapParentOutcome(worktreePath, parentOutcome);
    if (mapped.stoppedAt === null && mapped.failureReason === null) {
        const receipts = captureSourceTipReceipts(worktreePath, projectRoot, input.rootSourceBranch);
        persistSourceTipReceipts(input.taskNumber, input.runId, input.stepId, worktreePath, projectRoot, receipts);
    }
    const result: RebaseTaskWorktreeOutput = { lock: "acquired", heldByOwner: null, recoveryCommand: null, ...mapped };
    persistRebaseStepResult(input.taskNumber, input.runId, input.stepId, "rebaseTaskWorktree", worktreePath, projectRoot, result);
    return result;
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
