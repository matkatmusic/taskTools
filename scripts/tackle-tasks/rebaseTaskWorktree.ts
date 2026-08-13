// "lock the source repo, then rebase onto the target branch" + "did the rebase report
// conflicts?" (pipeline.mmd). Acquires the source-repo lock (re-entrant for the same owner,
// bounded wait per rule 9), then rebases every layer deepest-first with live conflict markers.
import { readFileSync } from "node:fs";
import {
    acquireSourceRepoLock, buildLockOwner, refreshSourceRepoLock,
} from "./sourceRepoLock.ts";
import { buildDiscoveryManifest } from "./occurrences.ts";
import { attachOperationBranch } from "../prepareTasks.ts";
import {
    rebaseParentOntoSourceAndTest, rebaseSubmoduleLayersDeepestFirst,
    type ParentRebaseOutcome, type SubmoduleLayerOutcome,
} from "../mergeTaskWorktrees.ts";

export type RebaseTaskWorktreeInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    rootSourceBranch: string;
};

export type RebaseTaskWorktreeOutput = {
    lock: "acquired" | "held" | "recoverable";
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

function mapSubmoduleStop(stoppedAt: SubmoduleLayerOutcome): Omit<RebaseTaskWorktreeOutput, "lock"> {
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

function mapParentOutcome(worktreePath: string, outcome: ParentRebaseOutcome): Omit<RebaseTaskWorktreeOutput, "lock"> {
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
    const owner = buildLockOwner(input.runId, input.taskNumber);
    const acquireResult = await acquireSourceRepoLockBounded(input.projectRoot, owner, lockOptions);
    if (acquireResult.lock !== "acquired") {
        return { lock: acquireResult.lock, conflicted: false, stoppedAt: null, conflictedFilePaths: [], failureReason: null };
    }
    refreshSourceRepoLock(input.projectRoot, owner);

    const manifest = buildDiscoveryManifest(input.worktreePath, input.projectRoot);
    manifest.repositoryManifest.occurrences = attachOperationBranch(manifest.repositoryManifest.occurrences, `task-${input.taskNumber}`);
    const submoduleReport = rebaseSubmoduleLayersDeepestFirst(input.worktreePath, manifest, true, null);
    if (submoduleReport.stoppedAt !== null) {
        return { lock: "acquired", ...mapSubmoduleStop(submoduleReport.stoppedAt) };
    }

    const parentOutcome = rebaseParentOntoSourceAndTest(
        "",
        input.worktreePath,
        input.rootSourceBranch,
        directChildPathsInParent(manifest),
        manifest.resolutionManifest,
        true,
        null,
    );
    return { lock: "acquired", ...mapParentOutcome(input.worktreePath, parentOutcome) };
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
