// Reads/creates the branch each repository (parent + submodules) should merge back onto.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export type RepositorySource = {
    path: string; // "" for the parent repo, else the submodule displaypath
    sourceBranch: string;
};

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

export function currentBranchName(repoRoot: string): string {
    return git(repoRoot, "branch", "--show-current");
}

export function submodulePaths(repoRoot: string): string[] {
    const output = execFileSync(
        "git",
        ["-C", repoRoot, "submodule", "--quiet", "foreach", "--recursive", "echo $displaypath"],
        { encoding: "utf8" },
    );
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function collectRepositorySources(repoRoot: string): RepositorySource[] {
    const paths = ["", ...submodulePaths(repoRoot)];
    const detachedPaths: string[] = [];
    const sources: RepositorySource[] = [];
    for (const path of paths) {
        const fullPath = path === "" ? repoRoot : join(repoRoot, path);
        const branch = currentBranchName(fullPath);
        if (branch === "") {
            detachedPaths.push(path === "" ? "(parent)" : path);
            continue;
        }
        sources.push({ path, sourceBranch: branch });
    }
    if (detachedPaths.length > 0) {
        throw new Error(
            `these repositories are on a detached HEAD and cannot be task-branched: ${detachedPaths.join(", ")}`,
        );
    }
    return sources;
}

// -B, not -b: a branch left behind by an earlier run must be reset onto HEAD, never reused as-is.
export function createBranchInEveryRepository(repoRoot: string, paths: string[], branchName: string): void {
    for (const path of paths) {
        git(path === "" ? repoRoot : join(repoRoot, path), "checkout", "-B", branchName);
    }
}
