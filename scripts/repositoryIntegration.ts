// Gitlink substitution and prepared no-ff merge primitives. Neither moves a branch or touches a base ref.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GitlinkSubstitution = {
    parentCommitOid: string;
    pathInParent: string;
    childOid: string;
};

export type RepositoryQualifiedConflict = {
    repoRoot: string;
    conflictedPaths: string[];
};

export type PrepareMergeResult =
    | { merged: true; commitOid: string }
    | { merged: false; conflict: RepositoryQualifiedConflict };

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function gitlinkModeAtPath(repoRoot: string, commitOid: string, path: string): string | null {
    const line = git(repoRoot, "ls-tree", commitOid, "--", path).trim();
    if (line === "") return null;
    return line.split(" ")[0];
}

// Replaces one gitlink entry via scratch-index tree surgery, then commits the new tree. No ref touched.
export function substituteGitlink(repoRoot: string, substitution: GitlinkSubstitution): string {
    const { parentCommitOid, pathInParent, childOid } = substitution;
    if (gitlinkModeAtPath(repoRoot, parentCommitOid, pathInParent) !== "160000") {
        throw new Error(`"${pathInParent}" is not a gitlink in commit ${parentCommitOid}`);
    }
    const scratchIndex = join(tmpdir(), `repo-integration-${randomUUID()}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    try {
        execFileSync("git", ["-C", repoRoot, "read-tree", parentCommitOid], { env });
        execFileSync(
            "git",
            ["-C", repoRoot, "update-index", "--add", "--cacheinfo", `160000,${childOid},${pathInParent}`],
            { env },
        );
        const newTreeOid = execFileSync("git", ["-C", repoRoot, "write-tree"], { encoding: "utf8", env }).trim();
        return git(
            repoRoot,
            "commit-tree",
            newTreeOid,
            "-p",
            parentCommitOid,
            "-m",
            `substitute gitlink at ${pathInParent} -> ${childOid}`,
        ).trim();
    } finally {
        rmSync(scratchIndex, { force: true });
    }
}

// Parses merge-tree conflict output: skip the tree-OID line, take the path from each remaining line.
function parseConflictedPaths(mergeTreeOutput: string): string[] {
    const [fileInfoBlock = ""] = mergeTreeOutput.split("\n\n");
    const [, ...fileInfoLines] = fileInfoBlock.split("\n");
    const paths = fileInfoLines.filter(Boolean).map((line) => line.split("\t")[1]);
    return [...new Set(paths)];
}

// Prepares a --no-ff merge commit via merge-tree plumbing. Returns the commit OID or conflict info.
export function prepareNoFfMerge(
    repoRoot: string,
    baseOid: string,
    tipOid: string,
    message: string,
): PrepareMergeResult {
    try {
        const treeOid = git(repoRoot, "merge-tree", "--write-tree", baseOid, tipOid).trim();
        const commitOid = git(repoRoot, "commit-tree", treeOid, "-p", baseOid, "-p", tipOid, "-m", message).trim();
        return { merged: true, commitOid };
    } catch (error) {
        const stdout = (error as { stdout?: string }).stdout ?? "";
        return { merged: false, conflict: { repoRoot, conflictedPaths: parseConflictedPaths(stdout) } };
    }
}
