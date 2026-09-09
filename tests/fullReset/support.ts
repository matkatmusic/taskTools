// Shared setup for tests/fullReset/*.test.ts: spawn, commit, merge, and close a task on a real repo shape.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoShape } from "../support/repoShapeFixtures.ts";
import { claimTask } from "../../scripts/tackle-tasks/shared/taskRunState.ts";
import { createTaskWorktree } from "../../scripts/tackle-tasks/shared/createTaskWorktree.ts";
import { mergeWorktreeTaskDeepestFirst } from "../../scripts/tackle-tasks/shared/occurrences.ts";
import { defaultMergeStepOperations } from "../../scripts/merge-worktree-tasks/mergeTaskWorktrees.ts";

export function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

export function refPresent(repoPath: string, refName: string): boolean {
    return spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", refName]).status === 0;
}

export function resetPointRef(taskNumber: number): string {
    return `refs/taskTools/reset-point/task-${taskNumber}`;
}

export function mergedCommitsRef(taskNumber: number): string {
    return `refs/taskTools/merged-commits/task-${taskNumber}`;
}

export function taskBranchRef(taskNumber: number): string {
    return `refs/heads/task-${taskNumber}`;
}

export const submodulePathsByShape: Record<RepoShape, string[]> = {
    none: [],
    "one-submodule": ["sub"],
    "two-submodules": ["sub-a", "sub-b"],
    "two-submodules-nested": ["sub-a/nested", "sub-a", "sub-b"],
};

// Appends to tasks.json/completedTasks.json, so a second task doesn't erase the first's completed record.
export function seedAndClaim(rootPath: string, taskNumber: number, runId: string): void {
    const tasksPath = join(rootPath, "tasks.json");
    const completedPath = join(rootPath, "completedTasks.json");
    const existingTasks = existsSync(tasksPath) ? JSON.parse(readFileSync(tasksPath, "utf8")) : [];
    writeFileSync(tasksPath, JSON.stringify([...existingTasks, { taskNumber, title: `t${taskNumber}`, modifiableFiles: [] }]));
    if (!existsSync(completedPath)) writeFileSync(completedPath, "[]");
    const outcome = claimTask(taskNumber, runId, rootPath);
    assert.equal(outcome.status, "claimed");
}

export function spawnTask(rootPath: string, taskNumber: number, runId: string): { worktree: string; branch: string } {
    seedAndClaim(rootPath, taskNumber, runId);
    return createTaskWorktree(taskNumber, runId, rootPath);
}

// Counts calls so repeat commits (two tasks touching the same submodule) always produce a real diff.
let commitWorktreeWorkCallCount = 0;

// One commit in the worktree root and one in each named submodule; mergeTaskDeepestFirst propagates the gitlinks itself.
export function commitWorktreeWork(worktreePath: string, submodulePaths: string[]): void {
    commitWorktreeWorkCallCount += 1;
    for (const relPath of submodulePaths) {
        const dir = join(worktreePath, relPath);
        writeFileSync(join(dir, "work.txt"), `work in ${relPath} (${commitWorktreeWorkCallCount})\n`);
        git(dir, "add", "work.txt");
        git(dir, "commit", "-q", "-m", `work in ${relPath}`);
    }
    writeFileSync(join(worktreePath, "root-work.txt"), `root work (${commitWorktreeWorkCallCount})\n`);
    git(worktreePath, "add", "root-work.txt");
    git(worktreePath, "commit", "-q", "-m", "root work");
}

export function mergeTask(worktreePath: string, rootPath: string, taskNumber: number): any {
    // runTests: false, matching production's mergeTaskWorktree.ts call: the suite already ran earlier in the real pipeline.
    const report = mergeWorktreeTaskDeepestFirst(worktreePath, rootPath, taskNumber, "staging", defaultMergeStepOperations, null, false);
    assert.equal(report.status, "merged", JSON.stringify(report));
    return report;
}

// Writes the completedTasks.json record a close leaves behind: commitHashes are the work tip and the merge commit.
export function closeTask(rootPath: string, taskNumber: number, worktreePath: string, report: any): void {
    const workCommit = git(worktreePath, "rev-parse", `task-${taskNumber}`);
    const rootLayer = report.completedLayers.find((layer: any) => layer.occurrenceId === "root");
    const mergeCommit = rootLayer.mergedCommitOid;

    const tasks = JSON.parse(readFileSync(join(rootPath, "tasks.json"), "utf8"));
    writeFileSync(join(rootPath, "tasks.json"), JSON.stringify(tasks.filter((t: any) => t.taskNumber !== taskNumber)));
    const completed = JSON.parse(readFileSync(join(rootPath, "completedTasks.json"), "utf8"));
    completed.push({ taskNumber, title: `t${taskNumber}`, commitHashes: [workCommit, mergeCommit] });
    writeFileSync(join(rootPath, "completedTasks.json"), JSON.stringify(completed));
}

export function mergeAndClose(rootPath: string, taskNumber: number, worktreePath: string): void {
    const report = mergeTask(worktreePath, rootPath, taskNumber);
    closeTask(rootPath, taskNumber, worktreePath, report);
}
