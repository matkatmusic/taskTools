// Reads the direct (non-recursive) gitlink entries of a commit via `git ls-tree -r`.
import { execFileSync } from "node:child_process";

export type GitlinkEntry = {
    path: string;
    oid: string;
};

export function readDirectGitlinks(repoRoot: string, commitish: string): GitlinkEntry[] {
    const output = execFileSync("git", ["-C", repoRoot, "ls-tree", "-r", commitish], { encoding: "utf8" });
    return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
            const [metadata, path] = line.split("\t");
            const [mode, , oid] = metadata.split(" ");
            return { mode, path, oid };
        })
        .filter((entry) => entry.mode === "160000")
        .map(({ path, oid }) => ({ path, oid }));
}
