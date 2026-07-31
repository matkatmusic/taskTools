// Merges each group's branch in ascending order; a conflict means a worker touched an undeclared file.
import { execFileSync } from "node:child_process";
import type { PreparedGroup, WorkflowArguments } from "./prepareTasks.ts";
import { appendRunMetricsRecord, computeArgumentsHash, runDurationMs } from "./tackleMetrics.ts";

type CliInput = WorkflowArguments & {
    runId?: string;
    startTimestamp?: string;
    doneCount?: number;
    partialCount?: number;
    blockedCount?: number;
    needsClarificationCount?: number;
    requeueCount?: number;
};

export type MergeOutcome = {
    groupId: number;
    merged: boolean;
    conflictedFilePaths: string[];
    worktree: string;
};

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

export function mergeGroupBranchIntoRepo(repoRoot: string, group: PreparedGroup): MergeOutcome {
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", `merge ${group.branch}`);
        return { groupId: group.groupId, merged: true, conflictedFilePaths: [], worktree: group.worktree };
    } catch {
        const conflictedFilePaths = git(repoRoot, "diff", "--name-only", "--diff-filter=U")
            .split("\n")
            .filter(Boolean);
        git(repoRoot, "merge", "--abort");
        return { groupId: group.groupId, merged: false, conflictedFilePaths, worktree: group.worktree };
    }
}

export function removeWorktreeAndBranch(repoRoot: string, worktreePath: string, branchName: string): void {
    git(repoRoot, "worktree", "remove", worktreePath, "--force");
    git(repoRoot, "branch", "-D", branchName);
}

function runAsCli(): void {
    const input: CliInput = JSON.parse(process.argv[2]);
    const workflowArguments: WorkflowArguments = { repo: input.repo, typecheckCommand: input.typecheckCommand, groups: input.groups };
    const sortedGroups = [...workflowArguments.groups].sort((a, b) => a.groupId - b.groupId);
    const merged: MergeOutcome[] = [];
    const conflicts: MergeOutcome[] = [];
    for (const group of sortedGroups) {
        const outcome = mergeGroupBranchIntoRepo(workflowArguments.repo, group);
        if (outcome.merged) {
            removeWorktreeAndBranch(workflowArguments.repo, group.worktree, group.branch);
            merged.push(outcome);
        } else {
            conflicts.push(outcome);
        }
    }
    const endTimestamp = new Date().toISOString();
    appendRunMetricsRecord(workflowArguments.repo, {
        runId: input.runId ?? endTimestamp,
        startTimestamp: input.startTimestamp ?? null,
        endTimestamp,
        durationMs: runDurationMs(input.startTimestamp ?? null, endTimestamp),
        taskNumbers: sortedGroups.flatMap((g) => g.tasks.map((t) => t.number)),
        groupCount: sortedGroups.length,
        doneCount: input.doneCount ?? 0,
        partialCount: input.partialCount ?? 0,
        blockedCount: input.blockedCount ?? 0,
        needsClarificationCount: input.needsClarificationCount ?? 0,
        requeueCount: input.requeueCount ?? 0,
        conflictCount: conflicts.length,
        argumentsHash: computeArgumentsHash(workflowArguments),
    });
    process.stdout.write(JSON.stringify({ merged, conflicts }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
