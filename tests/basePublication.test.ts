// Behavioral checks for basePublication.ts: local base publication with CAS, rollback, recovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    publishBases,
    publishCanonicalRef,
    rollbackUpdatedRefs,
} from "../scripts/basePublication.ts";
import type { PublicationTarget, UpdatedRef } from "../scripts/basePublication.ts";
import type { RunState } from "../scripts/approvalGate.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeRepo(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "base-publication-"));
    git(repoRoot, "init", "-q", "-b", "main");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    return repoRoot;
}

function commitFile(repoPath: string, fileName: string, content: string): string {
    writeFileSync(join(repoPath, fileName), content);
    git(repoPath, "add", "-A");
    git(repoPath, "commit", "-q", "-m", fileName);
    return git(repoPath, "rev-parse", "HEAD");
}

function approvedRunState(): RunState {
    return {
        readyForApproval: true,
        status: "approved",
        digestInput: {
            manifest: { version: 1, occurrences: [] },
            files: [],
            operationRef: "refs/operation/1",
            baseRef: "refs/heads/main",
            occurrenceDigests: [],
            testReceipts: [],
            reviewHandoffs: [],
        },
    };
}

function makeRootIntegration(exists: boolean): { repoPath: string; refName: string } {
    const repoPath = makeRepo();
    const refName = "refs/finalize/run-1/tip/root";
    if (exists) {
        const oid = commitFile(repoPath, "root.txt", "root");
        git(repoPath, "update-ref", refName, oid);
    }
    return { repoPath, refName };
}

// Canonical repo: recordedBaseOid on canonicalRefName, later commit as targetOid on "main".
function makeLogicalRepoFixture(name: string): { repo: PublicationTarget; otherPath: string } {
    const canonicalPath = makeRepo();
    const recordedBaseOid = commitFile(canonicalPath, "seed.txt", "seed");
    git(canonicalPath, "update-ref", "refs/heads/base", recordedBaseOid);
    const targetOid = commitFile(canonicalPath, "update.txt", "update");

    const otherPath = makeRepo();
    git(otherPath, "fetch", canonicalPath, "refs/heads/base:refs/heads/base");

    return {
        otherPath,
        repo: {
            name,
            canonicalOccurrencePath: canonicalPath,
            canonicalRefName: "refs/heads/base",
            otherOccurrences: [{ path: otherPath, refName: "refs/heads/base" }],
            recordedBaseOid,
            targetOid,
        },
    };
}

test("test_nothingPublishesBeforeRootIntegrationOidExists", () => {
    const { repo } = makeLogicalRepoFixture("repo-a");
    const rootIntegration = makeRootIntegration(false);

    const result = publishBases([repo], approvedRunState(), rootIntegration);

    assert.equal(result.published, false);
    assert.equal(result.rollback.length, 0);
    assert.equal(git(repo.canonicalOccurrencePath, "rev-parse", repo.canonicalRefName), repo.recordedBaseOid);
});

test("test_baseRefMovedSinceApprovalBlocksPublicationEntirely", () => {
    const fixtureA = makeLogicalRepoFixture("repo-a");
    const fixtureB = makeLogicalRepoFixture("repo-b");
    const rootIntegration = makeRootIntegration(true);

    // Simulate a concurrent mover advancing repo A's canonical ref before publication runs.
    git(fixtureA.repo.canonicalOccurrencePath, "update-ref", "refs/heads/base", fixtureA.repo.targetOid);

    const result = publishBases([fixtureA.repo, fixtureB.repo], approvedRunState(), rootIntegration);

    assert.equal(result.published, false);
    assert.equal(result.rollback.length, 0);
    assert.equal(
        git(fixtureB.repo.canonicalOccurrencePath, "rev-parse", fixtureB.repo.canonicalRefName),
        fixtureB.repo.recordedBaseOid,
    );
});

test("test_compareAndSwapPreventsClobberingConcurrentUpdate", () => {
    const { repo } = makeLogicalRepoFixture("repo-a");
    const concurrentOid = commitFile(repo.canonicalOccurrencePath, "concurrent.txt", "concurrent");
    // A concurrent mover sets the canonical ref to concurrentOid; repo.recordedBaseOid is now stale.
    git(repo.canonicalOccurrencePath, "update-ref", repo.canonicalRefName, concurrentOid);

    const result = publishCanonicalRef(repo);

    assert.equal(result.ok, false);
    assert.equal(git(repo.canonicalOccurrencePath, "rev-parse", repo.canonicalRefName), concurrentOid);
});

test("test_midSequenceFailureRollsBackEveryAlreadyUpdatedRefToRecordedOid", () => {
    const fixtureA = makeLogicalRepoFixture("repo-a");
    const fixtureB = makeLogicalRepoFixture("repo-b");
    const fixtureC = makeLogicalRepoFixture("repo-c");
    const rootIntegration = makeRootIntegration(true);

    // Force repo C's canonical CAS to fail without tripping pass-1: recordedBaseOid still matches, but targetOid is nonexistent.
    const failingRepoC: PublicationTarget = { ...fixtureC.repo, targetOid: "a".repeat(40) };

    const result = publishBases([fixtureA.repo, fixtureB.repo, failingRepoC], approvedRunState(), rootIntegration);

    assert.equal(result.published, false);
    for (const fixture of [fixtureA, fixtureB]) {
        assert.equal(
            git(fixture.repo.canonicalOccurrencePath, "rev-parse", fixture.repo.canonicalRefName),
            fixture.repo.recordedBaseOid,
        );
        assert.equal(git(fixture.otherPath, "rev-parse", fixture.repo.otherOccurrences[0].refName), fixture.repo.recordedBaseOid);
    }
});

test("test_failingRollbackPreservesIntegrationAndRecoveryRefsAndReportsExactCommandPerRepository", () => {
    const fixtureA = makeLogicalRepoFixture("repo-a");
    const fixtureB = makeLogicalRepoFixture("repo-b");

    const integrationRepo = makeRepo();
    const integrationRef = "refs/finalize/run-9/tip/root";
    git(integrationRepo, "update-ref", integrationRef, commitFile(integrationRepo, "root.txt", "root"));
    const recoveryRef = "refs/recovery/run-9/worker/w1";
    git(integrationRepo, "update-ref", recoveryRef, git(integrationRepo, "rev-parse", "HEAD"));
    const integrationOidBefore = git(integrationRepo, "rev-parse", integrationRef);
    const recoveryOidBefore = git(integrationRepo, "rev-parse", recoveryRef);

    // Simulate what a successful pass-2 would have collected for repos A and B.
    const updatedSoFar: UpdatedRef[] = [];
    for (const fixture of [fixtureA, fixtureB]) {
        const canonicalResult = publishCanonicalRef(fixture.repo);
        assert.equal(canonicalResult.ok, true);
        updatedSoFar.push(canonicalResult.updated!);
        git(
            fixture.otherPath,
            "fetch",
            fixture.repo.canonicalOccurrencePath,
            `${fixture.repo.canonicalRefName}:${fixture.repo.otherOccurrences[0].refName}`,
        );
        updatedSoFar.push({
            repoName: fixture.repo.name,
            occurrencePath: fixture.otherPath,
            refName: fixture.repo.otherOccurrences[0].refName,
            recordedOid: fixture.repo.recordedBaseOid,
            newOid: fixture.repo.targetOid,
        });
    }

    // A concurrent actor moves repo A's canonical ref again, after publish but before rollback.
    const concurrentOid = commitFile(fixtureA.repo.canonicalOccurrencePath, "concurrent.txt", "concurrent");
    git(fixtureA.repo.canonicalOccurrencePath, "update-ref", fixtureA.repo.canonicalRefName, concurrentOid);

    const outcomes = rollbackUpdatedRefs(updatedSoFar);

    const repoAOutcome = outcomes.find(
        (outcome) => outcome.ref.repoName === "repo-a" && outcome.ref.occurrencePath === fixtureA.repo.canonicalOccurrencePath,
    )!;
    const repoBOutcome = outcomes.find(
        (outcome) => outcome.ref.repoName === "repo-b" && outcome.ref.occurrencePath === fixtureB.repo.canonicalOccurrencePath,
    )!;

    assert.equal(repoBOutcome.rolledBack, true);
    assert.equal(repoAOutcome.rolledBack, false);
    assert.equal(
        repoAOutcome.recoveryCommand,
        `git -C ${fixtureA.repo.canonicalOccurrencePath} update-ref ${fixtureA.repo.canonicalRefName} ${fixtureA.repo.recordedBaseOid}`,
    );
    assert.equal(git(integrationRepo, "rev-parse", integrationRef), integrationOidBefore);
    assert.equal(git(integrationRepo, "rev-parse", recoveryRef), recoveryOidBefore);
});

test("test_otherOccurrencesFastForwardLocallyWithoutRemotePush", () => {
    const { repo, otherPath } = makeLogicalRepoFixture("repo-a");
    const rootIntegration = makeRootIntegration(true);

    const result = publishBases([repo], approvedRunState(), rootIntegration);

    assert.equal(result.published, true);
    assert.equal(git(otherPath, "rev-parse", repo.otherOccurrences[0].refName), repo.targetOid);
    assert.equal(git(otherPath, "remote"), "");
});
