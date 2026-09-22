// Merges a HEAD tip into staging in a caller-supplied detached worktree; a conflict leaves that worktree in place.
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { readStagingTip } from "./prepareTasks.ts";

export function mergeHeadIntoStaging(repoRoot: string, headTip: string, stagingRef: string, mergeWorktreePath: string): string | { conflict: true } {
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", mergeWorktreePath, stagingRef], { stdio: ["ignore", "ignore", "inherit"] });
    const merge = spawnSync("git", ["-C", mergeWorktreePath, "merge", "--no-edit", headTip], { encoding: "utf8" });
    if (merge.status !== 0) {
        // Merge worktree has no submodule checkout, so git cannot merge a gitlink; record the sub's fresh staging tip.
        const unmergedListing = execFileSync("git", ["-C", mergeWorktreePath, "ls-files", "-u", "-z"], { encoding: "utf8" });
        const unmergedEntries: string[] = [];
        for (const entry of unmergedListing.split("\0")) {
            const isEmpty = entry.length === 0;
            if (isEmpty) continue;
            unmergedEntries.push(entry);
        }
        const unmergedSubmodulePaths = new Set<string>();
        for (const entry of unmergedEntries) {
            const [info, path] = entry.split("\t");
            if (info.split(" ")[0] === "160000") unmergedSubmodulePaths.add(path);
        }
        for (const path of unmergedSubmodulePaths) {
            const subTip = readStagingTip(join(repoRoot, path));
            if (subTip === null) throw new Error(`no staging tip recorded for submodule "${path}" in "${repoRoot}"`);
            execFileSync("git", ["-C", mergeWorktreePath, "update-index", "--cacheinfo", `160000,${subTip},${path}`], { stdio: ["ignore", "ignore", "inherit"] });
        }
        const stillUnmerged = execFileSync("git", ["-C", mergeWorktreePath, "ls-files", "-u"], { encoding: "utf8" }).trim();
        if (stillUnmerged !== "") return { conflict: true };
        execFileSync("git", ["-C", mergeWorktreePath, "commit", "--no-edit"], { stdio: ["ignore", "ignore", "inherit"] });
    }
    return execFileSync("git", ["-C", mergeWorktreePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
