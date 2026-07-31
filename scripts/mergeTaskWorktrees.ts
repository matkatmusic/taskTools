// Merges each group's branch in ascending order; a conflict means a worker touched an undeclared file.
import { execFileSync } from "node:child_process";
import type { PreparedGroup, WorkflowArguments } from "./prepareTasks.ts";

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
    const workflowArguments: WorkflowArguments = JSON.parse(process.argv[2]);
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
    process.stdout.write(JSON.stringify({ merged, conflicts }));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) runAsCli();
