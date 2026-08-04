// Behavioral checks for baseBranchResolution.ts: exact tip-OID branch matching. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBaseBranchCandidates } from "../scripts/baseBranchResolution.ts";

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

function withTempGitRepo(body: (repoPath: string) => void): void {
    const repoPath = createTempGitRepo();
    try {
        body(repoPath);
    } finally {
        rmSync(repoPath, { recursive: true, force: true });
    }
}

test("a lone branch tip equal to the recorded OID is the sole match", () => {
    withTempGitRepo((repoPath) => {
        const recordedOid = commitNewFile(repoPath, "first.txt");
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        assert.deepEqual(result, { kind: "single", baseBranch: "main" });
    });
});

test("two branches at the same commit are both returned, sorted by name", () => {
    withTempGitRepo((repoPath) => {
        const recordedOid = commitNewFile(repoPath, "first.txt");
        createBranchAtCurrentHead(repoPath, "release");
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        assert.deepEqual(result, { kind: "multiple", candidates: ["main", "release"] });
    });
});

test("an OID that is an ancestor of every tip but the tip of none yields zero matches", () => {
    withTempGitRepo((repoPath) => {
        const recordedOid = commitNewFile(repoPath, "first.txt");
        commitNewFile(repoPath, "second.txt");
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        assert.deepEqual(result, { kind: "none", candidates: [] });
    });
});

test("a branch that merely contains the recorded OID is never reported as a match", () => {
    withTempGitRepo((repoPath) => {
        const recordedOid = commitNewFile(repoPath, "first.txt");
        createBranchAtCurrentHead(repoPath, "base");
        commitNewFile(repoPath, "second.txt");
        const result = resolveBaseBranchCandidates(repoPath, recordedOid);
        assert.deepEqual(result, { kind: "single", baseBranch: "base" });
    });
});
