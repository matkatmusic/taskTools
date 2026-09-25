// One permanent linked worktree on the source branch; merges land here, never in the user's checkout.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadRepositoryManifest, readStagingTip, resolveTaskWorktreeConventionDirectory, STAGING_REF } from "../../shared/prepareTasks.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

export function stagingWorktreePath(projectRoot: string): string {
  // RETIRED (task 232): folder renamed, staging now names only the branch.
  // return join(resolveTaskWorktreeConventionDirectory(projectRoot), "staging");
  return join(resolveTaskWorktreeConventionDirectory(projectRoot), "awaitingTesting");
}

// Checks the worktree is live and still points at sourceCheckoutPath, not a stale unrelated repo with a valid gitdir.
function isLiveWorktree(worktreePath: string, sourceCheckoutPath: string): boolean {
  const result = spawnSync("git", ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  if (result.status !== 0)
    return false;
  return result.stdout.trim() === git(sourceCheckoutPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
}

// --force: branch is always already checked out at sourceCheckoutPath, since that's how baseBranch gets derived.
function addOrVerifyLinkedWorktree(sourceCheckoutPath: string, worktreePath: string, branch: string): void {
  if (!existsSync(join(worktreePath, ".git")) || !isLiveWorktree(worktreePath, sourceCheckoutPath)) {
    rmSync(worktreePath, { recursive: true, force: true });
    git(sourceCheckoutPath, "worktree", "add", "--quiet", "--force", worktreePath, branch);
    return;
  }
  const found = git(worktreePath, "branch", "--show-current");
  // "" is a submodule layer left detached at its parent's recorded gitlink; that's the expected steady state.
  const isOnWrongBranch = found !== branch;
  const isDetached = found === "";
  const needsRebuildCheck = isOnWrongBranch && !isDetached;
  if (needsRebuildCheck) {
    // RETIRED (task 233): status --porcelain treated a stale index as real work.
    // const status = git(worktreePath, "status", "--porcelain");
    // if (status !== "") {
    //     throw new Error(`staging worktree at "${worktreePath}" is on "${found}", expected "${branch}"\n${status}`);
    // }
    // Spec work rule: a tracked-file diff or any untracked file is work.
    const diffResult = spawnSync("git", ["-C", worktreePath, "diff", "--quiet"], { encoding: "utf8" });
    const hasChangedTrackedFiles = diffResult.status !== 0;
    const untrackedFiles = git(worktreePath, "ls-files", "--others", "--exclude-standard");
    const hasUntrackedFiles = untrackedFiles !== "";
    const holdsWork = hasChangedTrackedFiles || hasUntrackedFiles;
    if (holdsWork) {
      const status = git(worktreePath, "status", "--porcelain");
      throw new Error(`staging worktree at "${worktreePath}" is on "${found}", expected "${branch}"\n${status}`);
    }
    // RETIRED (task 233): rmSync left stale worktree administrative state behind; git owns the rebuild now.
    // rmSync(worktreePath, { recursive: true, force: true });
    // A stale worktree from before staging existed sits on the old base branch; rebuild it when clean.
    git(sourceCheckoutPath, "worktree", "remove", "--force", worktreePath);
    git(sourceCheckoutPath, "worktree", "prune");
    git(sourceCheckoutPath, "worktree", "add", "--quiet", "--force", worktreePath, branch);
    return;
  }
}

// ponytail: `git worktree add` refuses when the user's own checkout already sits on the source branch; git's message is the error.
export function ensureStagingWorktree(projectRoot: string, rootSourceBranch: string): void {
  const rootPath = stagingWorktreePath(projectRoot);
  addOrVerifyLinkedWorktree(projectRoot, rootPath, rootSourceBranch);
  // Only the locked catch-up moves staging; this path only reads it.
  // resolveOrCreateStagingTipEverywhere(projectRoot);
  const stagingSubmodulePaths = git(projectRoot, "submodule", "foreach", "--recursive", "--quiet", "echo \"$displaypath\"")
    .split("\n")
    .filter((line) => line.length > 0);
  for (const repository of [...stagingSubmodulePaths.map((path) => join(projectRoot, path)), projectRoot]) {
    if (readStagingTip(repository) === null) throw new Error(`${STAGING_REF} is missing in "${repository}"; the staging catch-up must create it`);
  }
  const occurrences = loadRepositoryManifest(projectRoot, rootSourceBranch).occurrences
    .filter((occurrence) => occurrence.occurrenceId !== "")
    .sort((a, b) => a.depth - b.depth);
  for (const occurrence of occurrences) {
    const submoduleWorktreePath = join(rootPath, occurrence.occurrenceId);
    addOrVerifyLinkedWorktree(join(projectRoot, occurrence.occurrenceId), submoduleWorktreePath, "staging");
    // Plain git rules: the checkout sits at the gitlink the parent's checked-out tree records, not at "staging"'s own tip.
    const parentWorktreePath = join(rootPath, occurrence.parentOccurrenceId ?? "");
    const gitlink = git(parentWorktreePath, "rev-parse", `HEAD:${occurrence.pathInParent}`);
    git(submoduleWorktreePath, "checkout", "--quiet", "--detach", gitlink);
  }
}
