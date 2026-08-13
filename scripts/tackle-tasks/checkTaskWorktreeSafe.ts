// "is the worktree safe to use?" — plans/tackle-tasks-v1_5-plan.md Phase 3.
// Structural only: dirty is never by itself unsafe (rule 6 keeps the tree committed at every box that matters).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { taskBranchName } from "./createTaskWorktree.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

function git(worktreePath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", worktreePath, ...args], { encoding: "utf8" }).trim();
}

export type CheckTaskWorktreeSafeOutput = { safe: boolean; problems: string[] };

export function checkTaskWorktreeSafe(taskNumber: number, worktreePath: string): CheckTaskWorktreeSafeOutput {
    try {
        git(worktreePath, "rev-parse", "--is-inside-work-tree");
    } catch {
        return { safe: false, problems: [`"${worktreePath}" does not open as a git worktree`] };
    }

    const problems: string[] = [];
    const expectedBranch = taskBranchName(taskNumber);
    const currentBranch = git(worktreePath, "branch", "--show-current");
    if (currentBranch !== expectedBranch) {
        problems.push(`HEAD is on "${currentBranch || "(detached)"}", expected "${expectedBranch}"`);
    }

    // F9: --recursive so a populated direct child with an uninitialized grandchild is caught.
    // git already reports each nested submodule's path root-relative to worktreePath here.
    if (existsSync(join(worktreePath, ".gitmodules"))) {
        let status: string;
        try {
            status = git(worktreePath, "submodule", "status", "--recursive");
        } catch (error) {
            return { safe: false, problems: [`submodule status check failed: ${(error as Error).message}`] };
        }
        for (const line of status.split("\n").filter((line) => line.length > 0)) {
            if (line.startsWith("-")) {
                const submodulePath = line.trim().split(/\s+/)[1] ?? "(unknown)";
                problems.push(`submodule "${submodulePath}" is not populated`);
            }
        }
    }

    return { safe: problems.length === 0, problems };
}

export type CheckTaskWorktreeSafeCliInput = { taskNumber: number; worktreePath: string };

if (process.argv[1]?.endsWith("checkTaskWorktreeSafe.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CheckTaskWorktreeSafeCliInput;
    const worktreePath = requireAbsolutePath("worktreePath", input.worktreePath);
    const output = checkTaskWorktreeSafe(input.taskNumber, worktreePath);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
