// Behavioral checks for operationBranches.ts: branch-at-recorded-oid, idempotency, conflict, and abort-on-unready.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import {
    OperationBranchConflictError,
    OperationBranchSetupError,
    operationBranchName,
    setUpOperationBranches,
} from "../scripts/operationBranches.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempGitRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "operation-branches-"));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    return repoPath;
}

function commit(repoPath: string, fileName: string): string {
    writeFileSync(join(repoPath, fileName), `${fileName}\n`);
    git(repoPath, "add", fileName);
    git(repoPath, "commit", "-q", "-m", fileName);
    return git(repoPath, "rev-parse", "HEAD");
}

function makeOccurrence(overrides: Partial<RepositoryOccurrence>): RepositoryOccurrence {
    return {
        occurrenceId: "root",
        checkoutPath: "",
        parentOccurrenceId: null,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: "https://example.com/root.git",
        baseBranch: "main",
        baseOid: "0".repeat(40),
        operationBranch: "",
        childOccurrenceIds: [],
        testState: "untested",
        ...overrides,
    };
}

function assertNoWorktreeDirectoryCreated(occurrence: RepositoryOccurrence): void {
    const workerWorktreePath = join(tmpdir(), "worktrees", occurrence.occurrenceId);
    assert.equal(existsSync(workerWorktreePath), false);
}

test("test_branchCreatedAtRecordedOidEvenWhenCheckoutIsElsewhere", () => {
    const repoPath = makeTempGitRepo();
    const oidA = commit(repoPath, "a.txt");
    commit(repoPath, "b.txt");
    const occurrence = makeOccurrence({ checkoutPath: repoPath, baseOid: oidA, baseBranch: "main" });

    const [result] = setUpOperationBranches([occurrence], "run1");
    const branchName = operationBranchName("run1", occurrence);

    assert.equal(git(repoPath, "rev-parse", branchName), oidA);
    assert.equal(git(repoPath, "branch", "--show-current"), branchName);
    assert.equal(result.operationBranch, branchName);
});

test("test_reRunningIsANoOp", () => {
    const repoPath = makeTempGitRepo();
    const oidA = commit(repoPath, "a.txt");
    commit(repoPath, "b.txt");
    const occurrence = makeOccurrence({ checkoutPath: repoPath, baseOid: oidA, baseBranch: "main" });

    setUpOperationBranches([occurrence], "run1");
    const branchName = operationBranchName("run1", occurrence);
    const oidAfterFirstRun = git(repoPath, "rev-parse", branchName);
    const branchesAfterFirstRun = git(repoPath, "branch", "--list");

    assert.doesNotThrow(() => setUpOperationBranches([occurrence], "run1"));
    assert.equal(git(repoPath, "rev-parse", branchName), oidAfterFirstRun);
    assert.equal(git(repoPath, "branch", "--list"), branchesAfterFirstRun);
});

test("test_existingBranchAtDifferentOidErrors", () => {
    const repoPath = makeTempGitRepo();
    const oidA = commit(repoPath, "a.txt");
    const oidB = commit(repoPath, "b.txt");
    const occurrence = makeOccurrence({ checkoutPath: repoPath, baseOid: oidA, baseBranch: "main" });
    const branchName = operationBranchName("run1", occurrence);
    git(repoPath, "branch", branchName, oidB);

    assert.throws(
        () => setUpOperationBranches([occurrence], "run1"),
        (error: unknown) => {
            assert.ok(error instanceof OperationBranchConflictError);
            assert.match((error as Error).message, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            assert.match((error as Error).message, new RegExp(branchName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            assert.match((error as Error).message, new RegExp(oidA));
            assert.match((error as Error).message, new RegExp(oidB));
            return true;
        },
    );
    assert.equal(git(repoPath, "rev-parse", branchName), oidB);
    assertNoWorktreeDirectoryCreated(occurrence);
});

test("test_detachedHeadOccurrenceAbortsSetupAndNamesIt", () => {
    const repoPath = makeTempGitRepo();
    const oidA = commit(repoPath, "a.txt");
    git(repoPath, "checkout", "-q", oidA);
    const occurrence = makeOccurrence({ checkoutPath: repoPath, baseOid: oidA, baseBranch: "main" });
    const branchName = operationBranchName("run1", occurrence);

    assertNoWorktreeDirectoryCreated(occurrence);
    assert.throws(
        () => setUpOperationBranches([occurrence], "run1"),
        (error: unknown) => {
            assert.ok(error instanceof OperationBranchSetupError);
            assert.match((error as Error).message, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            return true;
        },
    );
    assert.throws(() => git(repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`));
    assertNoWorktreeDirectoryCreated(occurrence);
});

test("test_occurrenceWithNoResolvedBaseBranchAbortsSetup", () => {
    const repoPath = makeTempGitRepo();
    const oidA = commit(repoPath, "a.txt");
    const occurrence = makeOccurrence({ checkoutPath: repoPath, baseOid: oidA, baseBranch: "" });
    const branchName = operationBranchName("run1", occurrence);

    assertNoWorktreeDirectoryCreated(occurrence);
    assert.throws(
        () => setUpOperationBranches([occurrence], "run1"),
        (error: unknown) => {
            assert.ok(error instanceof OperationBranchSetupError);
            assert.match((error as Error).message, new RegExp(repoPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            return true;
        },
    );
    assert.throws(() => git(repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`));
    assertNoWorktreeDirectoryCreated(occurrence);
});
