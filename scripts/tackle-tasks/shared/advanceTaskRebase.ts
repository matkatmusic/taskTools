// Implements pipeline.mmd's advance-rebase step: continues the stopped layer, resumes rebaseTaskWorktree's deepest-first walk; finished layers are no-ops.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "./sourceRepoLock.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { buildDiscoveryManifest, rebaseWorktreeSubmoduleLayersDeepestFirst } from "./occurrences.ts";
import { createEmptyResolutionManifest } from "../../resolutionRequests.ts";
import {
    captureSourceTipReceipts, persistRebaseStepResult, persistSourceTipReceipts,
} from "./rebaseTaskWorktree.ts";
import {
    rebaseInProgress, rebaseParentOntoSourceAndTest,
    type ParentRebaseOutcome, type SubmoduleLayerOutcome,
} from "../../mergeTaskWorktrees.ts";

export type AdvanceTaskRebaseInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    stepId: string;
    rootSourceBranch: string;
    stoppedAt: { occurrenceId: string; checkoutPath: string };
};

export type AdvanceTaskRebaseOutput = {
    finished: boolean;
    conflicted: boolean;
    stoppedAt: { occurrenceId: string; checkoutPath: string } | null;
    conflictedFilePaths: string[];
    failureReason: string | null;
};

function git(checkoutPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", checkoutPath, ...args], { encoding: "utf8" });
}

function collectConflictedPaths(checkoutPath: string): string[] {
    return git(checkoutPath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
}

// Mirrors continueRebaseChecked in tackle-tasks-v1_1_AgentPromptEmitter.ts: editor disabled so a plain --continue never blocks on an interactive prompt.
function continueRebaseChecked(checkoutPath: string): { continued: boolean; freshConflict: boolean; failureReason: string | null } {
    try {
        execFileSync("git", ["-C", checkoutPath, "rebase", "--continue"], {
            stdio: "ignore", env: { ...process.env, GIT_EDITOR: "true" },
        });
        return { continued: true, freshConflict: false, failureReason: null };
    } catch (error) {
        if (collectConflictedPaths(checkoutPath).length > 0) return { continued: false, freshConflict: true, failureReason: null };
        const failure = error as { message?: string };
        return { continued: false, freshConflict: false, failureReason: failure.message ?? "git rebase --continue failed" };
    }
}

function abortRebaseChecked(checkoutPath: string): { aborted: boolean; failureReason: string | null } {
    try {
        execFileSync("git", ["-C", checkoutPath, "rebase", "--abort"], { stdio: "ignore" });
        return { aborted: true, failureReason: null };
    } catch (error) {
        const failure = error as { message?: string };
        return { aborted: false, failureReason: failure.message ?? "git rebase --abort failed" };
    }
}

// Repeatedly continues the stopped layer's rebase until it finishes or hits a fresh conflict.
function advanceStoppedLayer(stoppedAt: AdvanceTaskRebaseInput["stoppedAt"]): AdvanceTaskRebaseOutput | null {
    while (rebaseInProgress(stoppedAt.checkoutPath)) {
        const continuation = continueRebaseChecked(stoppedAt.checkoutPath);
        if (continuation.freshConflict) {
            return {
                finished: false, conflicted: true, stoppedAt, conflictedFilePaths: collectConflictedPaths(stoppedAt.checkoutPath), failureReason: null,
            };
        }
        if (!continuation.continued) {
            const abortResult = abortRebaseChecked(stoppedAt.checkoutPath);
            const abortFailure = abortResult.aborted ? "" : `; abort also failed: ${abortResult.failureReason}`;
            throw new Error(`git rebase --continue failed in "${stoppedAt.checkoutPath}": ${continuation.failureReason}${abortFailure}`);
        }
    }
    return null;
}

function directChildPathsInParent(manifest: ReturnType<typeof buildDiscoveryManifest>): string[] {
    return manifest.repositoryManifest.occurrences
        .filter((occurrence) => occurrence.parentOccurrenceId === "")
        .map((occurrence) => occurrence.pathInParent)
        .filter((path): path is string => path !== null);
}

function mapSubmoduleStop(stoppedAt: SubmoduleLayerOutcome): AdvanceTaskRebaseOutput {
    const stoppedAtField = { occurrenceId: stoppedAt.occurrenceId, checkoutPath: stoppedAt.checkoutPath };
    if (stoppedAt.status === "conflicted") {
        return { finished: false, conflicted: true, stoppedAt: stoppedAtField, conflictedFilePaths: stoppedAt.conflictedFilePaths, failureReason: null };
    }
    if (stoppedAt.status === "tests-failed") {
        return { finished: false, conflicted: false, stoppedAt: stoppedAtField, conflictedFilePaths: [], failureReason: `${stoppedAt.failedCheck}: ${stoppedAt.testOutput}` };
    }
    const reason = "failureReason" in stoppedAt ? stoppedAt.failureReason : `test policy needs resolution for "${stoppedAt.occurrenceId}"`;
    throw new Error(`rebase of occurrence "${stoppedAt.occurrenceId}" failed operationally: ${reason}`);
}

function mapParentOutcome(worktreePath: string, outcome: ParentRebaseOutcome): AdvanceTaskRebaseOutput {
    const stoppedAtField = { occurrenceId: "", checkoutPath: worktreePath };
    if (outcome.status === "conflicted") {
        return { finished: false, conflicted: true, stoppedAt: stoppedAtField, conflictedFilePaths: outcome.conflictedFilePaths, failureReason: null };
    }
    if (outcome.status === "tests-failed") {
        return { finished: false, conflicted: false, stoppedAt: stoppedAtField, conflictedFilePaths: [], failureReason: `${outcome.failedCheck}: ${outcome.testOutput}` };
    }
    if (outcome.status === "rebased") {
        return { finished: true, conflicted: false, stoppedAt: null, conflictedFilePaths: [], failureReason: null };
    }
    if (outcome.status === "rebased-and-tested") {
        return { finished: true, conflicted: false, stoppedAt: null, conflictedFilePaths: [], failureReason: null };
    }
    const reason = outcome.status === "untested" ? "test policy needs resolution for root" : outcome.failureReason;
    throw new Error(`rebase of the root occurrence failed operationally: ${reason}`);
}

// Verifies finished by reading the world, not an exit code; no layer may still be rebasing (worktree-only check, F1).
function verifyNoRebaseInProgressAnywhere(worktreePath: string, projectRoot: string, rootSourceBranch: string): void {
    const manifest = buildDiscoveryManifest(worktreePath, projectRoot, rootSourceBranch);
    for (const occurrence of manifest.repositoryManifest.occurrences) {
        if (rebaseInProgress(occurrence.checkoutPath)) {
            throw new Error(`rebase reported finished but occurrence "${occurrence.occurrenceId}" still has one in progress`);
        }
    }
}

export function advanceTaskRebase(input: AdvanceTaskRebaseInput): AdvanceTaskRebaseOutput {
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const worktreePath = requireAbsolutePath("worktreePath", input.worktreePath);
    const owner = buildLockOwner(input.runId, input.taskNumber);
    refreshOwnedSourceRepoLockOrThrow(projectRoot, owner);

    const freshConflict = advanceStoppedLayer(input.stoppedAt);
    if (freshConflict !== null) {
        persistRebaseStepResult(input.taskNumber, input.runId, input.stepId, "advanceTaskRebase", worktreePath, projectRoot, input.rootSourceBranch, freshConflict);
        return freshConflict;
    }

    // Rebase only: pipeline-rebase.mmd runs no tests; pipeline-suite.mmd runs the suite afterwards.
    const submoduleReport = rebaseWorktreeSubmoduleLayersDeepestFirst(worktreePath, projectRoot, input.taskNumber, input.rootSourceBranch, true, null, false);
    if (submoduleReport.stoppedAt !== null) {
        const result = mapSubmoduleStop(submoduleReport.stoppedAt);
        persistRebaseStepResult(input.taskNumber, input.runId, input.stepId, "advanceTaskRebase", worktreePath, projectRoot, input.rootSourceBranch, result);
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
    const result = mapParentOutcome(worktreePath, parentOutcome);
    if (result.finished) {
        verifyNoRebaseInProgressAnywhere(worktreePath, projectRoot, input.rootSourceBranch);
        const receipts = captureSourceTipReceipts(worktreePath, projectRoot, input.rootSourceBranch);
        persistSourceTipReceipts(input.taskNumber, input.runId, input.stepId, worktreePath, projectRoot, input.rootSourceBranch, receipts);
    }
    persistRebaseStepResult(input.taskNumber, input.runId, input.stepId, "advanceTaskRebase", worktreePath, projectRoot, input.rootSourceBranch, result);
    return result;
}

if (process.argv[1]?.endsWith("advanceTaskRebase.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as AdvanceTaskRebaseInput;
    const output = advanceTaskRebase(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
