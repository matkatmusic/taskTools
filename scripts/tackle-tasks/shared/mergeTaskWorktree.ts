// F3: before merging, re-verifies each source's base-branch tip and clean state, since other git activity can bypass the lock.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "./sourceRepoLock.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { buildWorktreeOccurrences, mergeWorktreeTaskDeepestFirst } from "./occurrences.ts";
import { getCurrentTaskRun, type TaskCommit, type SourceTipReceipt } from "./taskRunState.ts";
import { resolveTaskFiles } from "../../shared/taskFiles.ts";
import { defaultMergeStepOperations, type MergeLayerOutcome, type MergeTaskWalkReport } from "../../merge-worktree-tasks/mergeTaskWorktrees.ts";
import { logStepOutput } from "./logStepOutput.ts";
import { STATUS_PATH_IGNORABLE, STATUS_PATH_NOT_IGNORABLE } from "../../shared/resultCodes.ts";

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
    failureReason: string;
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

// The root checkout's task files always change from this run, not unrelated dirt, so skip the clean check.
function taskStateIgnorablePaths(checkoutPath: string, projectRoot: string): string[] {
    if (checkoutPath !== projectRoot) return [];
    const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
    return [relative(checkoutPath, tasksPath), relative(checkoutPath, completedTasksPath)];
}

function isIgnorableStatusPath(path: string, ignorablePaths: string[]): number {
    return ignorablePaths.includes(path) ? STATUS_PATH_IGNORABLE : STATUS_PATH_NOT_IGNORABLE;
}

// NUL-safe: `-z` parses paths intact; a rename or copy entry's second NUL-terminated "from" path belongs to that same entry.
function sourceCheckoutStatusPaths(checkoutPath: string): string[] {
    const output = git(checkoutPath, "status", "--porcelain=v1", "--untracked-files=all", "-z");
    const tokens = output.split("\0").filter((token) => token.length > 0);
    const paths: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const entry = tokens[i];
        paths.push(entry.slice(3));
        if (entry[0] === "R" || entry[0] === "C") i++;
    }
    return paths;
}

// F3: checks each receipt's baseBranch against the tip rebase recorded, then confirms the checkout is clean and usable.
function verifySourceTipsUnchangedSinceRebase(worktreePath: string, projectRoot: string, rootSourceBranch: string, receipts: SourceTipReceipt[]): void {
    const sourceCheckoutPathByOccurrenceId = new Map<string, string>([["", projectRoot]]);
    for (const occurrence of buildWorktreeOccurrences(worktreePath, projectRoot, rootSourceBranch)) {
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
        const relevantPaths = sourceCheckoutStatusPaths(checkoutPath).filter((path) => isIgnorableStatusPath(path, ignorablePaths) !== STATUS_PATH_IGNORABLE);
        if (relevantPaths.length > 0) {
            throw new Error(`source checkout at "${checkoutPath}" is dirty, refusing to merge over unrelated changes:\n${relevantPaths.join("\n")}`);
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
        return { merged: true, commits: mergeCommitsFromLayers(report.completedLayers, null), failureReason: "" };
    }
    if (report.status === "root-merged-but-not-closed") {
        return { merged: true, commits: mergeCommitsFromLayers(report.completedLayers, report.mergedCommitHash), failureReason: report.failureReason };
    }
    // submodule-conflicted, parent-conflicted, merge-record-missing
    return { merged: false, commits: mergeCommitsFromLayers(report.completedLayers, null), failureReason: report.failureReason ?? "" };
}

export function mergeTaskWorktree(input: MergeTaskWorktreeInput): MergeTaskWorktreeOutput {
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const worktreePath = requireAbsolutePath("worktreePath", input.worktreePath);
    const owner = buildLockOwner(input.runId, input.taskNumber);
    refreshOwnedSourceRepoLockOrThrow(projectRoot, owner);

    const receipts = readSourceTipReceipts(input.taskNumber, input.runId, projectRoot);
    verifySourceTipsUnchangedSinceRebase(worktreePath, projectRoot, input.rootSourceBranch, receipts);

    // pipeline-suite.mmd already ran the suite, so the merge itself runs no tests.
    const report = mergeWorktreeTaskDeepestFirst(worktreePath, projectRoot, input.taskNumber, input.rootSourceBranch, defaultMergeStepOperations, null, false);
    return mapReport(report);
}

const MERGE_TASK_WORKTREE_SOURCE = "scripts/tackle-tasks/mergeTaskWorktree.ts:125: mergeTaskWorktree";

if (process.argv[1]?.endsWith("mergeTaskWorktree.ts")) {
    const payloadText = readFileSync(0, "utf8");
    const input = JSON.parse(payloadText) as MergeTaskWorktreeInput & { boxId?: string };
    const identity = { projectRoot: input.projectRoot, taskNumber: input.taskNumber, runId: input.runId };
    const boxId = input.boxId ?? "mergeTaskWorktree";
    const command = `node ${process.argv[1]} <<'TTMERGE'\n${payloadText}\nTTMERGE`;

    try {
        const output = mergeTaskWorktree(input);
        const commandOutput = `${JSON.stringify(output)}\n`;
        logStepOutput(identity, { boxId, source: MERGE_TASK_WORKTREE_SOURCE, input, command, commandOutput, output });
        process.stdout.write(commandOutput);
    } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logStepOutput(identity, { boxId, source: MERGE_TASK_WORKTREE_SOURCE, input, command, commandOutput: message, output: { error: message } });
        throw error;
    }
}
