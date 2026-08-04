import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBaseBranchCandidates } from "../scripts/baseBranchResolution";

function runGitCommand(repoPath: string, args: string[]): string {
    const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
}

function createTempGitRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "base-branch-resolution-"));
    runGitCommand(repoPath, ["init", "--initial-branch=main"]);
    runGitCommand(repoPath, ["config", "user.email", "test@example.com"]);
    runGitCommand(repoPath, ["config", "user.name", "Test"]);
    return repoPath;
}

function commitNewFile(repoPath: string, fileName: string): string {
    runGitCommand(repoPath, ["commit", "--allow-empty", "-m", fileName]);
    return runGitCommand(repoPath, ["rev-parse", "HEAD"]);
}

function createBranchAtCurrentHead(repoPath: string, branchName: string): void {
    runGitCommand(repoPath, ["branch", branchName]);
}

describe("resolveBaseBranchCandidates", () => {
    let repoPath: string;

    beforeEach(() => {
        repoPath = createTempGitRepo();
    });

    afterEach(() => {
        rmSync(repoPath, { recursive: true, force: true });
    });

    test("test_singleBranchTipMatchingRecordedOidYieldsSoleMatch", () => {
        // Scenario: exactly one branch tip equals the recorded OID.  Steps: a repo has one commit on "main".
        const recordedOid = commitNewFile(repoPath, "first.txt");
        // no other branch is created.  resolving candidates against that commit's OID
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        // should report exactly one match: "main".
        expect(result).toEqual({ kind: "single", baseBranch: "main" });
    });

    test("test_twoBranchesAtSameCommitYieldBothInDeterministicOrder", () => {
        // Scenario: two branches point at the same commit.  Steps: a repo has one commit on "main".
        const recordedOid = commitNewFile(repoPath, "first.txt");
        // a second branch "release" is created pointing at that same commit.
        createBranchAtCurrentHead(repoPath, "release");
        // resolving candidates against that shared OID
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        // should report both branches, sorted by name.
        expect(result).toEqual({ kind: "multiple", candidates: ["main", "release"] });
    });

    test("test_ancestorOidNotAnyBranchTipYieldsZeroMatches", () => {
        // Ancestor OID, not any branch tip, must yield zero matches.  a repo has a first commit (the recorded OID).
        const recordedOid = commitNewFile(repoPath, "first.txt");
        // a second commit is made on "main", moving its tip past the recorded OID.
        commitNewFile(repoPath, "second.txt");
        // resolving candidates against the ancestor OID
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        // should report zero matches, since no branch tip equals the recorded OID.
        expect(result).toEqual({ kind: "none", candidates: [] });
    });

    test("test_branchContainingButNotAtRecordedOidIsExcludedFromMatches", () => {
        // "base" tip equals recorded OID; "main" merely contains it, further ahead.
        const recordedOid = commitNewFile(repoPath, "first.txt");
        // a "base" branch is created pointing at that exact commit.
        createBranchAtCurrentHead(repoPath, "base");
        // "main" then advances past it with a second commit.
        commitNewFile(repoPath, "second.txt");
        // resolving candidates against the recorded OID
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        // should report only "base" as the sole match.
        expect(result).toEqual({ kind: "single", baseBranch: "base" });
        // "main" must never appear, even though it contains the recorded commit in its history.
        if (result.kind === "single") {
            expect(result.baseBranch).not.toBe("main");
        }
    });
});
