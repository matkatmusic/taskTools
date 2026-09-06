// "does the task's file list cover what the worktree touched?" — pipeline-worktreeCheck.mmd.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { computeExemptGitlinkPaths } from "./checkTaskFileFence.ts";
import { buildOccurrencePath, buildOwnedOccurrencePaths, getOccurrencesDeepestFirst } from "./occurrences.ts";
import { readTaskFile, resolveTaskFiles } from "../../shared/taskFiles.ts";
import { modifiableFiles } from "../../shared/prepareTasks.ts";
import { currentBranchName } from "../../shared/repositoryBranches.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type CheckResumedWorktreeFenceInput = {
    projectRoot: string;
    worktreePath: string;
    taskNumber: number;
};

export type CheckResumedWorktreeFenceOutput = { inside: boolean; violations: string[] };

function git(checkoutPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", checkoutPath, ...args], { encoding: "utf8" });
}

function declaredFiles(taskNumber: number, projectRoot: string): string[] {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    const task = readTaskFile(tasksPath).find((candidate) => candidate.taskNumber === taskNumber);
    if (task === undefined) throw new Error(`task ${taskNumber} not found`);
    return modifiableFiles(task);
}

export function checkResumedWorktreeFence(input: CheckResumedWorktreeFenceInput): CheckResumedWorktreeFenceOutput {
    requireAbsolutePath("projectRoot", input.projectRoot);
    requireAbsolutePath("worktreePath", input.worktreePath);

    // const rootSourceBranch = currentBranchName(input.projectRoot);
    // Worktrees are cut from staging (prepareTasks.ts), so the fence diffs against staging, like DID_CHANGES_STAY_INSIDE_FENCE_Q.
    const rootSourceBranch = "staging";
    const occurrences = getOccurrencesDeepestFirst(input.worktreePath, input.projectRoot, rootSourceBranch);
    const ownedPaths = new Set(buildOwnedOccurrencePaths(declaredFiles(input.taskNumber, input.projectRoot), occurrences));

    const changedPathsByOccurrenceId = new Map<string, string[]>();
    const allChangedPaths: string[] = [];
    for (const occurrence of occurrences) {
        const committed = git(occurrence.checkoutPath, "diff", "--name-only", `${occurrence.baseRef}...HEAD`);
        // "diff HEAD" is staged and unstaged together, which is what a resumed worktree may hold.
        const uncommitted = git(occurrence.checkoutPath, "diff", "--name-only", "HEAD");
        const relativePaths = [...new Set(`${committed}\n${uncommitted}`.split("\n").filter(Boolean))];
        const taggedPaths = relativePaths.map((relativePath) => buildOccurrencePath(occurrence.occurrenceId, relativePath));
        changedPathsByOccurrenceId.set(occurrence.occurrenceId, taggedPaths);
        allChangedPaths.push(...taggedPaths);
    }

    const exemptGitlinkPaths = computeExemptGitlinkPaths(input.worktreePath, input.projectRoot, rootSourceBranch, changedPathsByOccurrenceId, ownedPaths);

    // ponytail: the pipeline's own resume bookkeeping file, always dirty after a run, exempt like a gitlink.
    const violations = allChangedPaths.filter(
        (path) => path !== "plans/checkpoint.json" && !ownedPaths.has(path) && !exemptGitlinkPaths.has(path),
    );
    return { inside: violations.length === 0, violations };
}

if (process.argv[1]?.endsWith("checkResumedWorktreeFence.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CheckResumedWorktreeFenceInput;
    const output = checkResumedWorktreeFence(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
