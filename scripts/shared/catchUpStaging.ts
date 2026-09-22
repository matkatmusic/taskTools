// Catches up staging with HEAD in every submodule, deepest first, then the root; a diverged merge uses task-N-catchUpMerge.
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { mergeHeadIntoStaging } from "./mergeHelpers.ts";
import { moveStagingBranchTo, readStagingTip, resolveOrCreateStagingTip, resolveTaskWorktreeConventionDirectory, STAGING_REF } from "./prepareTasks.ts";

export type CatchUpConflict = { repository: string; worktreePath: string };

// null means every repository caught up; a conflict stops the walk and leaves its merge worktree in place.
export function catchUpStaging(repoRoot: string, taskNumber: number): CatchUpConflict | null {
    const submoduleListing = execFileSync(
        "git",
        ["-C", repoRoot, "submodule", "foreach", "--recursive", "--quiet", "echo \"$displaypath\""],
        { encoding: "utf8" },
    );
    const submoduleDisplayPaths: string[] = [];
    for (const line of submoduleListing.split("\n")) {
        const isEmpty = line.length === 0;
        if (isEmpty) continue;
        submoduleDisplayPaths.push(line);
    }
    submoduleDisplayPaths.sort((a, b) => b.split("/").length - a.split("/").length);
    const repositories: string[] = [];
    for (const displayPath of submoduleDisplayPaths) {
        repositories.push(join(repoRoot, displayPath));
    }
    repositories.push(repoRoot);
    for (const repository of repositories) {
        const stagingTip = readStagingTip(repository);
        // Absent: resolveOrCreateStagingTip creates staging at HEAD without a merge worktree.
        if (stagingTip === null) {
            resolveOrCreateStagingTip(repository);
            continue;
        }
        const headTip = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        const stagingIsAncestorOfHead = spawnSync("git", ["-C", repository, "merge-base", "--is-ancestor", stagingTip, headTip], { stdio: "ignore" });
        // At HEAD or behind it: resolveOrCreateStagingTip moves staging to HEAD without a merge worktree.
        if (stagingIsAncestorOfHead.status === 0) {
            resolveOrCreateStagingTip(repository);
            continue;
        }
        const headIsAncestorOfStaging = spawnSync("git", ["-C", repository, "merge-base", "--is-ancestor", headTip, stagingTip], { stdio: "ignore" });
        if (headIsAncestorOfStaging.status === 0) continue;
        const mergeWorktreePath = join(resolveTaskWorktreeConventionDirectory(repository), `task-${taskNumber}-catchUpMerge`);
        const mergeResult = mergeHeadIntoStaging(repository, headTip, STAGING_REF, mergeWorktreePath);
        if (typeof mergeResult !== "string") return { repository, worktreePath: mergeWorktreePath };
        moveStagingBranchTo(repository, mergeResult);
        execFileSync("git", ["-C", repository, "worktree", "remove", "--force", mergeWorktreePath], { stdio: ["ignore", "ignore", "inherit"] });
        execFileSync("git", ["-C", repository, "worktree", "prune"], { stdio: ["ignore", "ignore", "inherit"] });
    }
    return null;
}
