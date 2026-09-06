// One permanent linked worktree on the source branch; merges land here, never in the user's checkout.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadRepositoryManifest, resolveTaskWorktreeConventionDirectory } from "../../shared/prepareTasks.ts";

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function stagingWorktreePath(projectRoot: string): string {
    return join(resolveTaskWorktreeConventionDirectory(projectRoot), "staging");
}

// A rebuilt source .git orphans this worktree's gitdir pointer; check it's still live.
function isLiveWorktree(worktreePath: string): boolean {
    return spawnSync("git", ["-C", worktreePath, "rev-parse", "--git-dir"], { stdio: "ignore" }).status === 0;
}

// --force: branch is always already checked out at sourceCheckoutPath, since that's how baseBranch gets derived.
function addOrVerifyLinkedWorktree(sourceCheckoutPath: string, worktreePath: string, branch: string): void {
    if (!existsSync(join(worktreePath, ".git")) || !isLiveWorktree(worktreePath)) {
        rmSync(worktreePath, { recursive: true, force: true });
        git(sourceCheckoutPath, "worktree", "add", "--quiet", "--force", worktreePath, branch);
        return;
    }
    const found = git(worktreePath, "branch", "--show-current");
    if (found !== branch) {
        throw new Error(`staging worktree at "${worktreePath}" is on "${found}", expected "${branch}"`);
    }
}

// ponytail: `git worktree add` refuses when the user's own checkout already sits on the source branch; git's message is the error.
export function ensureStagingWorktree(projectRoot: string, rootSourceBranch: string): void {
    const rootPath = stagingWorktreePath(projectRoot);
    addOrVerifyLinkedWorktree(projectRoot, rootPath, rootSourceBranch);
    const occurrences = loadRepositoryManifest(projectRoot, rootSourceBranch).occurrences
        .filter((occurrence) => occurrence.occurrenceId !== "")
        .sort((a, b) => a.depth - b.depth);
    for (const occurrence of occurrences) {
        addOrVerifyLinkedWorktree(join(projectRoot, occurrence.occurrenceId), join(rootPath, occurrence.occurrenceId), occurrence.baseBranch);
    }
}
