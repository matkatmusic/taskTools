// "merge worktrees and submodules, no fast-forward" + "did the merge land?" (pipeline.mmd).
// F3: immediately before merging, while proving lock ownership, re-verifies every source
// occurrence's base-branch tip against the receipt rebase left behind, and that every source
// checkout is structurally usable and clean - the lock serializes v1.5 tasks against each
// other, but ordinary git operations and other skills do not honor it, so a source checkout can
// move or go dirty while the lock holds, without changing its branch name or leaving it dirty
// forever (a clean new commit is enough to invalidate what rebase tested against).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "./sourceRepoLock.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { buildWorktreeOccurrences, mergeWorktreeTaskDeepestFirst } from "./occurrences.ts";
import { getCurrentTaskRun, type TaskCommit, type SourceTipReceipt } from "./taskRunState.ts";
import { resolveTaskFiles } from "../taskFiles.ts";
import { type MergeLayerOutcome, type MergeTaskWalkReport } from "../mergeTaskWorktrees.ts";

export type MergeTaskWorktreeInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
    runId: string;
    rootSourceBranch: string;
};

export type MergeTaskWorktreeOutput = {
    merged: boolean;
    commits: TaskCommit[];
    failureReason: string | null;
};

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function readSourceTipReceipts(taskNumber: number, runId: string, projectRoot: string): SourceTipReceipt[] {
    const currentRun = getCurrentTaskRun(taskNumber, projectRoot);
    if (currentRun === null || currentRun.runId !== runId) {
        throw new Error(`task ${taskNumber}'s active run does not match runId "${runId}"; refusing to merge`);
    }
    const receipts = currentRun.sourceTipsAtRebase;
    if (receipts === undefined || receipts.length === 0) {
        throw new Error(`task ${taskNumber}'s run "${runId}" has no recorded rebase receipt; merge cannot verify the source tip it was tested against`);
    }
    return receipts;
}

// The root source checkout always carries the tool's own tasks.json/completedTasks.json,
// mutated directly on disk by every claim/state write in this same run - never "unrelated"
// dirt, so it must not trip the clean check every active run would otherwise always fail.
function taskStateIgnorablePaths(checkoutPath: string, projectRoot: string): string[] {
    if (checkoutPath !== projectRoot) return [];
    const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
    return [relative(checkoutPath, tasksPath), relative(checkoutPath, completedTasksPath)];
}

function isIgnorableStatusLine(line: string, ignorablePaths: string[]): boolean {
    const path = line.slice(3).replace(/\/$/, "");
    return ignorablePaths.some((ignorable) => path === ignorable || ignorable.startsWith(`${path}/`));
}

// F3: rev-parses every receipt's baseBranch in its live source checkout and compares against
// the tip rebase recorded, then confirms the checkout is structurally usable and clean.
function verifySourceTipsUnchangedSinceRebase(worktreePath: string, projectRoot: string, receipts: SourceTipReceipt[]): void {
    const sourceCheckoutPathByOccurrenceId = new Map<string, string>([["", projectRoot]]);
    for (const occurrence of buildWorktreeOccurrences(worktreePath, projectRoot)) {
        sourceCheckoutPathByOccurrenceId.set(occurrence.occurrenceId, occurrence.sourceCheckoutPath);
    }

    for (const receipt of receipts) {
        const checkoutPath = sourceCheckoutPathByOccurrenceId.get(receipt.occurrenceId);
        if (checkoutPath === undefined) {
            throw new Error(`rebase receipt names occurrence "${receipt.occurrenceId}", which no longer exists in the source manifest`);
        }
        let actualTip: string;
        try {
            actualTip = git(checkoutPath, "rev-parse", receipt.baseBranch).trim();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`source checkout at "${checkoutPath}" is not structurally usable: ${message}`);
        }
        if (actualTip !== receipt.sourceTip) {
            throw new Error(
                `source occurrence "${receipt.occurrenceId}" branch "${receipt.baseBranch}" moved from `
                + `"${receipt.sourceTip}" to "${actualTip}" since rebase; refusing to merge an unverified tip`,
            );
        }
        const ignorablePaths = taskStateIgnorablePaths(checkoutPath, projectRoot);
        const statusLines = git(checkoutPath, "status", "--porcelain").trim().split("\n").filter(Boolean);
        const relevantLines = statusLines.filter((line) => !isIgnorableStatusLine(line, ignorablePaths));
        if (relevantLines.length > 0) {
            throw new Error(`source checkout at "${checkoutPath}" is dirty, refusing to merge over unrelated changes:\n${relevantLines.join("\n")}`);
        }
    }
}

function mergeCommitsFromLayers(layers: MergeLayerOutcome[], extraRootCommitHash: string | null): TaskCommit[] {
    const commits: TaskCommit[] = layers
        .filter((layer): layer is MergeLayerOutcome & { mergedCommitOid: string } => layer.mergedCommitOid !== null)
        .map((layer) => ({
            occurrenceId: layer.occurrenceId === "root" ? "" : layer.occurrenceId,
            hash: layer.mergedCommitOid,
            kind: "merge",
        }));
    if (extraRootCommitHash !== null && !commits.some((commit) => commit.occurrenceId === "" && commit.hash === extraRootCommitHash)) {
        commits.push({ occurrenceId: "", hash: extraRootCommitHash, kind: "merge" });
    }
    return commits;
}

function mapReport(report: MergeTaskWalkReport): MergeTaskWorktreeOutput {
    if (report.status === "merged") {
        return { merged: true, commits: mergeCommitsFromLayers(report.completedLayers, null), failureReason: null };
    }
    if (report.status === "root-merged-but-not-closed") {
        return { merged: true, commits: mergeCommitsFromLayers(report.completedLayers, report.mergedCommitHash), failureReason: report.failureReason };
    }
    // submodule-conflicted, parent-conflicted, merge-record-missing
    return { merged: false, commits: mergeCommitsFromLayers(report.completedLayers, null), failureReason: report.failureReason };
}

export function mergeTaskWorktree(input: MergeTaskWorktreeInput): MergeTaskWorktreeOutput {
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const worktreePath = requireAbsolutePath("worktreePath", input.worktreePath);
    const owner = buildLockOwner(input.runId, input.taskNumber);
    refreshOwnedSourceRepoLockOrThrow(projectRoot, owner);

    const receipts = readSourceTipReceipts(input.taskNumber, input.runId, projectRoot);
    verifySourceTipsUnchangedSinceRebase(worktreePath, projectRoot, receipts);

    const report = mergeWorktreeTaskDeepestFirst(worktreePath, projectRoot, input.taskNumber);
    return mapReport(report);
}

if (process.argv[1]?.endsWith("mergeTaskWorktree.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as MergeTaskWorktreeInput;
    const output = mergeTaskWorktree(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
