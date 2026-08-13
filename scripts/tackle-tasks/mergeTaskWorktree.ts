// "merge worktrees and submodules, no fast-forward" + "did the merge land?" (pipeline.mmd).
// Re-verifies the source checkout is on the right branch and clean immediately before
// merging - the lock serializes v1.5 tasks against each other, but ordinary git operations
// and other skills do not honor it, so the checkout can move or go dirty while the lock holds.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildLockOwner, refreshSourceRepoLock } from "./sourceRepoLock.ts";
import { attachOperationBranch, loadRepositoryManifest } from "../prepareTasks.ts";
import { currentBranchName } from "../repositoryBranches.ts";
import { createEmptyResolutionManifest } from "../resolutionRequests.ts";
import type { DiscoveryManifest } from "../repositoryDiscovery.ts";
import { mergeTaskDeepestFirst, type MergeLayerOutcome, type MergeTaskWalkReport } from "../mergeTaskWorktrees.ts";
import type { TaskCommit } from "./taskRunState.ts";

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
    const owner = buildLockOwner(input.runId, input.taskNumber);
    refreshSourceRepoLock(input.projectRoot, owner);

    const actualBranch = currentBranchName(input.projectRoot);
    if (actualBranch !== input.rootSourceBranch) {
        throw new Error(`source checkout at "${input.projectRoot}" is on branch "${actualBranch}", expected "${input.rootSourceBranch}"`);
    }
    const statusOutput = git(input.projectRoot, "status", "--porcelain").trim();
    if (statusOutput !== "") {
        throw new Error(`source checkout at "${input.projectRoot}" is dirty, refusing to merge over unrelated changes:\n${statusOutput}`);
    }

    // mergeTaskDeepestFirst fetches each submodule's task branch INTO manifest.checkoutPath
    // (the true source submodule) FROM the discovered worktree checkout - so this manifest,
    // unlike rebaseTaskWorktree's, must keep the real (non-worktree) checkoutPath that
    // buildDiscoveryManifest deliberately remaps away; using the remapped one makes every
    // submodule merge fetch into its own checked-out branch, which git refuses outright.
    const sourceManifest = loadRepositoryManifest(input.projectRoot);
    const manifest: DiscoveryManifest = {
        repositoryManifest: {
            ...sourceManifest,
            occurrences: attachOperationBranch(sourceManifest.occurrences, `task-${input.taskNumber}`),
        },
        resolutionManifest: createEmptyResolutionManifest(),
    };
    const report = mergeTaskDeepestFirst(input.worktreePath, manifest);
    return mapReport(report);
}

if (process.argv[1]?.endsWith("mergeTaskWorktree.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as MergeTaskWorktreeInput;
    const output = mergeTaskWorktree(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
