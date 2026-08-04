import { spawnSync } from "node:child_process";

export type BaseBranchResolution =
    | { kind: "single"; baseBranch: string }
    | { kind: "none"; candidates: [] }
    | { kind: "multiple"; candidates: string[] };

function listLocalBranchTips(repoPath: string): { branchName: string; tipOid: string }[] {
    const result = spawnSync(
        "git",
        ["for-each-ref", "--format=%(refname:short) %(objectname)", "--sort=refname", "refs/heads/"],
        { cwd: repoPath, encoding: "utf8" }
    );
    if (result.status !== 0) {
        throw new Error(`git for-each-ref failed in ${repoPath}: ${result.stderr}`);
    }
    return result.stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
            const [branchName, tipOid] = line.split(" ");
            return { branchName, tipOid };
        });
}

export function resolveBaseBranchCandidates(repoPath: string, recordedOid: string): BaseBranchResolution {
    const branchTips = listLocalBranchTips(repoPath);
    const matchingBranchNames = branchTips
        .filter((branch) => branch.tipOid === recordedOid)
        .map((branch) => branch.branchName);

    if (matchingBranchNames.length === 1) {
        return { kind: "single", baseBranch: matchingBranchNames[0] };
    }
    if (matchingBranchNames.length === 0) {
        return { kind: "none", candidates: [] };
    }
    return { kind: "multiple", candidates: matchingBranchNames };
}
