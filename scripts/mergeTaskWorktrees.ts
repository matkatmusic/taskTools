// Merges each group's branch (and its submodules') back onto their source branches, deepest submodule first.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { PreparedGroup, WorkflowArguments } from "./prepareTasks.ts";
import { currentBranchName } from "./repositoryBranches.ts";
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
    submoduleConflicts: Array<{ path: string; conflictedFilePaths: string[] }>;
    worktree: string;
};

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

export function mergeGroupBranchIntoRepo(
    repoRoot: string,
    group: PreparedGroup,
    sourceBranch: string,
    submodulePaths: string[] = [],
): MergeOutcome {
    git(repoRoot, "checkout", sourceBranch);
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", `merge ${group.branch}`);
        return { groupId: group.groupId, merged: true, conflictedFilePaths: [], submoduleConflicts: [], worktree: group.worktree };
    } catch {
        const resolution = resolveGitlinkConflicts(repoRoot, submodulePaths);
        if (resolution.resolved) {
            return { groupId: group.groupId, merged: true, conflictedFilePaths: [], submoduleConflicts: [], worktree: group.worktree };
        }
        return { groupId: group.groupId, merged: false, conflictedFilePaths: resolution.unexpectedConflicts, submoduleConflicts: [], worktree: group.worktree };
    }
}

export function resolveGitlinkConflicts(
    repoRoot: string,
    submodulePaths: string[],
): { resolved: boolean; unexpectedConflicts: string[] } {
    const conflictedPaths = git(repoRoot, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    const unexpectedConflicts = conflictedPaths.filter((path) => !submodulePaths.includes(path));
    if (unexpectedConflicts.length > 0) {
        git(repoRoot, "merge", "--abort");
        return { resolved: false, unexpectedConflicts };
    }
    for (const path of conflictedPaths) git(repoRoot, "add", path);
    git(repoRoot, "commit", "--no-edit");
    return { resolved: true, unexpectedConflicts: [] };
}

export function mergeSubmoduleBranchIntoRepo(
    mainSubmodulePath: string,
    worktreeSubmodulePath: string,
    sourceBranch: string,
): { merged: boolean; conflictedFilePaths: string[] } {
    const groupBranch = currentBranchName(worktreeSubmodulePath);
    git(mainSubmodulePath, "fetch", worktreeSubmodulePath, `${groupBranch}:refs/heads/${groupBranch}`);
    git(mainSubmodulePath, "checkout", sourceBranch);
    try {
        git(mainSubmodulePath, "merge", "--no-ff", groupBranch, "-m", `merge ${groupBranch}`);
        return { merged: true, conflictedFilePaths: [] };
    } catch {
        const conflictedFilePaths = git(mainSubmodulePath, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
        git(mainSubmodulePath, "merge", "--abort");
        return { merged: false, conflictedFilePaths };
    }
}

export function removeWorktreeAndBranch(repoRoot: string, worktreePath: string, branchName: string): void {
    git(repoRoot, "worktree", "remove", worktreePath, "--force");
    git(repoRoot, "branch", "-D", branchName);
}

function runAsCli(): void {
    const input: CliInput = JSON.parse(process.argv[2]);
    const workflowArguments: WorkflowArguments = {
        repo: input.repo,
        typecheckCommand: input.typecheckCommand,
        groups: input.groups,
        repositorySources: input.repositorySources,
    };
    const sortedGroups = [...workflowArguments.groups].sort((a, b) => a.groupId - b.groupId);
    const submodulePathsDeepestFirst = workflowArguments.repositorySources
        .map((source) => source.path)
        .filter((path) => path !== "")
        .sort((a, b) => b.split("/").length - a.split("/").length);
    const findSourceBranch = (path: string): string => {
        const found = workflowArguments.repositorySources.find((source) => source.path === path);
        if (!found) throw new Error(`no recorded source branch for repository path "${path}"`);
        return found.sourceBranch;
    };

    const merged: MergeOutcome[] = [];
    const conflicts: MergeOutcome[] = [];
    for (const group of sortedGroups) {
        const submoduleConflicts: Array<{ path: string; conflictedFilePaths: string[] }> = [];
        for (const submodulePath of submodulePathsDeepestFirst) {
            const outcome = mergeSubmoduleBranchIntoRepo(
                join(workflowArguments.repo, submodulePath),
                join(group.worktree, submodulePath),
                findSourceBranch(submodulePath),
            );
            if (!outcome.merged) submoduleConflicts.push({ path: submodulePath, conflictedFilePaths: outcome.conflictedFilePaths });
        }
        if (submoduleConflicts.length > 0) {
            conflicts.push({ groupId: group.groupId, merged: false, conflictedFilePaths: [], submoduleConflicts, worktree: group.worktree });
            continue;
        }
        const outcome = mergeGroupBranchIntoRepo(workflowArguments.repo, group, findSourceBranch(""), submodulePathsDeepestFirst);
        if (outcome.merged) merged.push(outcome); else conflicts.push(outcome);
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
