// Behavioral checks for basePublication.ts: local base publication with CAS, rollback, recovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    defaultCheckoutOperations,
    publishBases,
    publishCanonicalRef,
    rollbackUpdatedRefs,
} from "../scripts/basePublication.ts";
import type { CheckoutOperations, PublicationTarget, UpdatedRef } from "../scripts/basePublication.ts";
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

type CheckedOutPublicationFixture = {
    repo: PublicationTarget;
    canonicalPath: string;
    recordedBaseOid: string;
    targetOid: string;
};

// Rewinds branch, index and files to the recorded base: the state publication receives.
function makeCheckedOutPublicationFixture(name: string): CheckedOutPublicationFixture {
    const canonicalPath = makeRepo();
    writeFileSync(join(canonicalPath, "local.txt"), "unchanged\n");
    const recordedBaseOid = commitFile(canonicalPath, "tracked.txt", "before\n");

    writeFileSync(join(canonicalPath, "tracked.txt"), "after\n");
    writeFileSync(join(canonicalPath, "merged.txt"), "merged\n");
    git(canonicalPath, "add", "-A");
    git(canonicalPath, "commit", "-q", "-m", "target");
    const targetOid = git(canonicalPath, "rev-parse", "HEAD");

    git(canonicalPath, "reset", "--hard", recordedBaseOid);
    return {
        canonicalPath,
        recordedBaseOid,
        targetOid,
        repo: {
            name,
            canonicalOccurrencePath: canonicalPath,
            canonicalRefName: "refs/heads/main",
            otherOccurrences: [],
            recordedBaseOid,
            targetOid,
        },
    };
}

function treeOid(repoPath: string, commitOid: string): string {
    return git(repoPath, "rev-parse", `${commitOid}^{tree}`);
}

function assertCheckoutAtRecordedBase(fixture: CheckedOutPublicationFixture): void {
    assert.equal(git(fixture.canonicalPath, "rev-parse", "HEAD"), fixture.recordedBaseOid);
    assert.equal(git(fixture.canonicalPath, "write-tree"), treeOid(fixture.canonicalPath, fixture.recordedBaseOid));
    assert.equal(readFileSync(join(fixture.canonicalPath, "tracked.txt"), "utf8"), "before\n");
    assert.equal(existsSync(join(fixture.canonicalPath, "merged.txt")), false);
}

function assertPublishedFilesAtTarget(fixture: CheckedOutPublicationFixture): void {
    assert.equal(git(fixture.canonicalPath, "rev-parse", "HEAD"), fixture.targetOid);
    assert.equal(readFileSync(join(fixture.canonicalPath, "tracked.txt"), "utf8"), "after\n");
    assert.equal(readFileSync(join(fixture.canonicalPath, "merged.txt"), "utf8"), "merged\n");
}

function assertCheckoutAtTarget(fixture: CheckedOutPublicationFixture): void {
    assertPublishedFilesAtTarget(fixture);
    assert.equal(git(fixture.canonicalPath, "write-tree"), treeOid(fixture.canonicalPath, fixture.targetOid));
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

test("test_publishingCheckedOutCanonicalRefRefreshesRealIndexAndWorkingTree", () => {
    const fixture = makeCheckedOutPublicationFixture("checked-out-canonical");

    const result = publishBases([fixture.repo], approvedRunState(), makeRootIntegration(true));

    assert.equal(result.published, true);
    assert.deepEqual(result.rollback, []);
    assert.deepEqual(result.checkoutRollback, []);
    assertCheckoutAtTarget(fixture);
    assert.equal(git(fixture.canonicalPath, "status", "--short"), "");
});

test("test_publishingCheckedOutCanonicalRefInstallsTargetAddedFile", () => {
    const fixture = makeCheckedOutPublicationFixture("target-add");

    const result = publishBases([fixture.repo], approvedRunState(), makeRootIntegration(true));

    assert.equal(result.published, true);
    assert.equal(existsSync(join(fixture.canonicalPath, "merged.txt")), true);
    assert.equal(readFileSync(join(fixture.canonicalPath, "merged.txt"), "utf8"), "merged\n");
    assert.equal(git(fixture.canonicalPath, "status", "--short", "--", "merged.txt"), "");
});

test("test_publishingCheckedOutCanonicalRefPreservesUnrelatedUnstagedEdit", () => {
    const fixture = makeCheckedOutPublicationFixture("unstaged-edit");
    writeFileSync(join(fixture.canonicalPath, "local.txt"), "real unstaged edit\n");

    const result = publishBases([fixture.repo], approvedRunState(), makeRootIntegration(true));

    assert.equal(result.published, true);
    assertCheckoutAtTarget(fixture);
    assert.equal(readFileSync(join(fixture.canonicalPath, "local.txt"), "utf8"), "real unstaged edit\n");
    assert.match(git(fixture.canonicalPath, "status", "--short", "--", "local.txt"), /M local\.txt$/);
    assert.equal(git(fixture.canonicalPath, "diff", "--cached", "--name-only", "--", "local.txt"), "");
});

test("test_publishingCheckedOutCanonicalRefPreservesUnrelatedStagedEdit", () => {
    const fixture = makeCheckedOutPublicationFixture("staged-edit");
    writeFileSync(join(fixture.canonicalPath, "local.txt"), "real staged edit\n");
    git(fixture.canonicalPath, "add", "--", "local.txt");
    const stagedBlobBefore = git(fixture.canonicalPath, "rev-parse", ":local.txt");

    const result = publishBases([fixture.repo], approvedRunState(), makeRootIntegration(true));

    assert.equal(result.published, true);
    assertPublishedFilesAtTarget(fixture);
    assert.equal(git(fixture.canonicalPath, "rev-parse", ":local.txt"), stagedBlobBefore);
    assert.equal(readFileSync(join(fixture.canonicalPath, "local.txt"), "utf8"), "real staged edit\n");
    assert.equal(git(fixture.canonicalPath, "diff", "--name-only", "--", "local.txt"), "");
    assert.equal(git(fixture.canonicalPath, "diff", "--cached", "--name-only", "--", "local.txt"), "local.txt");
});

test("test_publishingCheckedOutCanonicalRefPreservesUnrelatedUntrackedFile", () => {
    const fixture = makeCheckedOutPublicationFixture("untracked-file");
    writeFileSync(join(fixture.canonicalPath, "scratch.txt"), "do not touch\n");

    const result = publishBases([fixture.repo], approvedRunState(), makeRootIntegration(true));

    assert.equal(result.published, true);
    assertCheckoutAtTarget(fixture);
    assert.equal(readFileSync(join(fixture.canonicalPath, "scratch.txt"), "utf8"), "do not touch\n");
    assert.equal(git(fixture.canonicalPath, "status", "--short", "--", "scratch.txt"), "?? scratch.txt");
});

test("test_overlappingTrackedEditBlocksCheckedOutRefPublication", () => {
    const fixture = makeCheckedOutPublicationFixture("overlapping-edit");
    writeFileSync(join(fixture.canonicalPath, "tracked.txt"), "real overlapping edit\n");

    const result = publishBases([fixture.repo], approvedRunState(), makeRootIntegration(true));

    assert.equal(result.published, false);
    assert.deepEqual(result.rollback, []);
    assert.deepEqual(result.checkoutRollback, []);
    assert.equal(git(fixture.canonicalPath, "rev-parse", "refs/heads/main"), fixture.recordedBaseOid);
    assert.equal(git(fixture.canonicalPath, "write-tree"), treeOid(fixture.canonicalPath, fixture.recordedBaseOid));
    assert.equal(readFileSync(join(fixture.canonicalPath, "tracked.txt"), "utf8"), "real overlapping edit\n");
});

test("test_untrackedTargetPathBlocksCheckedOutRefPublication", () => {
    const fixture = makeCheckedOutPublicationFixture("untracked-collision");
    writeFileSync(join(fixture.canonicalPath, "merged.txt"), "local untracked bytes\n");

    const result = publishBases([fixture.repo], approvedRunState(), makeRootIntegration(true));

    assert.equal(result.published, false);
    assert.deepEqual(result.rollback, []);
    assert.deepEqual(result.checkoutRollback, []);
    assert.equal(git(fixture.canonicalPath, "rev-parse", "refs/heads/main"), fixture.recordedBaseOid);
    assert.equal(readFileSync(join(fixture.canonicalPath, "merged.txt"), "utf8"), "local untracked bytes\n");
    assert.equal(git(fixture.canonicalPath, "status", "--short", "--", "merged.txt"), "?? merged.txt");
});

test("test_publishingRefDoesNotRefreshDetachedCanonicalCheckout", () => {
    const fixture = makeCheckedOutPublicationFixture("detached-head");
    git(fixture.canonicalPath, "checkout", "-q", "--detach", fixture.recordedBaseOid);

    const result = publishBases([fixture.repo], approvedRunState(), makeRootIntegration(true));

    assert.equal(result.published, true);
    assert.equal(git(fixture.canonicalPath, "rev-parse", "refs/heads/main"), fixture.targetOid);
    assert.equal(git(fixture.canonicalPath, "rev-parse", "HEAD"), fixture.recordedBaseOid);
    assert.equal(git(fixture.canonicalPath, "write-tree"), treeOid(fixture.canonicalPath, fixture.recordedBaseOid));
    assert.equal(existsSync(join(fixture.canonicalPath, "merged.txt")), false);
    assert.equal(git(fixture.canonicalPath, "status", "--short"), "");
});

test("test_publishingRefDoesNotRefreshDifferentCheckedOutBranch", () => {
    const fixture = makeCheckedOutPublicationFixture("different-branch");
    git(fixture.canonicalPath, "checkout", "-q", "-b", "local-work", fixture.recordedBaseOid);

    const result = publishBases([fixture.repo], approvedRunState(), makeRootIntegration(true));

    assert.equal(result.published, true);
    assert.equal(git(fixture.canonicalPath, "rev-parse", "refs/heads/main"), fixture.targetOid);
    assert.equal(git(fixture.canonicalPath, "symbolic-ref", "HEAD"), "refs/heads/local-work");
    assert.equal(git(fixture.canonicalPath, "rev-parse", "HEAD"), fixture.recordedBaseOid);
    assert.equal(git(fixture.canonicalPath, "write-tree"), treeOid(fixture.canonicalPath, fixture.recordedBaseOid));
    assert.equal(existsSync(join(fixture.canonicalPath, "merged.txt")), false);
});

// The other occurrence has its destination branch checked out, so its fetch refuses after both refs moved.
test("test_laterRefFailureRollsBackRefsBeforeAnyCheckoutIsTransitioned", () => {
    const fixtureA = makeCheckedOutPublicationFixture("repo-a");
    const fixtureB = makeCheckedOutPublicationFixture("repo-b");
    const checkedOutOtherOccurrence = makeRepo();
    commitFile(checkedOutOtherOccurrence, "other.txt", "divergent checkout\n");
    fixtureB.repo.otherOccurrences = [{
        path: checkedOutOtherOccurrence,
        refName: "refs/heads/main",
    }];

    const result = publishBases(
        [fixtureA.repo, fixtureB.repo],
        approvedRunState(),
        makeRootIntegration(true),
    );

    assert.equal(result.published, false);
    assert.equal(result.rollback.length, 2);
    assert.ok(result.rollback.every((outcome) => outcome.rolledBack));
    assert.deepEqual(result.checkoutRollback, []);
    assertCheckoutAtRecordedBase(fixtureA);
    assertCheckoutAtRecordedBase(fixtureB);
});

test("test_checkoutApplicationFailureReversesAppliedCheckoutsAndPublishedRefs", () => {
    const fixtureA = makeCheckedOutPublicationFixture("repo-a");
    const fixtureB = makeCheckedOutPublicationFixture("repo-b");
    let applyCount = 0;
    const failSecondApply: CheckoutOperations = {
        ...defaultCheckoutOperations,
        apply: (transition) => {
            applyCount += 1;
            return applyCount === 2 ? false : defaultCheckoutOperations.apply(transition);
        },
    };

    const result = publishBases(
        [fixtureA.repo, fixtureB.repo],
        approvedRunState(),
        makeRootIntegration(true),
        failSecondApply,
    );

    assert.equal(result.published, false);
    assert.equal(applyCount, 2);
    assert.equal(result.checkoutRollback.length, 1);
    assert.equal(result.checkoutRollback[0].rolledBack, true);
    assert.equal(result.rollback.length, 2);
    assert.ok(result.rollback.every((outcome) => outcome.rolledBack));
    assertCheckoutAtRecordedBase(fixtureA);
    assertCheckoutAtRecordedBase(fixtureB);
    assert.equal(git(fixtureA.canonicalPath, "status", "--short"), "");
    assert.equal(git(fixtureB.canonicalPath, "status", "--short"), "");
});

test("test_parentCheckoutRefreshDoesNotRecurseIntoDetachedNestedCheckout", () => {
    const childSource = makeRepo();
    const childBaseOid = commitFile(childSource, "child.txt", "child before\n");
    const childTargetOid = commitFile(childSource, "child.txt", "child after\n");
    git(childSource, "reset", "--hard", childBaseOid);

    const parentPath = makeRepo();
    git(
        parentPath,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        "-q",
        childSource,
        "vendor",
    );
    git(parentPath, "commit", "-q", "-m", "parent base");
    const parentBaseOid = git(parentPath, "rev-parse", "HEAD");
    const nestedPath = join(parentPath, "vendor");
    git(nestedPath, "checkout", "-q", "--detach", childBaseOid);

    git(parentPath, "update-index", "--cacheinfo", `160000,${childTargetOid},vendor`);
    git(parentPath, "commit", "-q", "-m", "parent target gitlink");
    const parentTargetOid = git(parentPath, "rev-parse", "HEAD");
    git(parentPath, "reset", "--hard", parentBaseOid);

    const repo: PublicationTarget = {
        name: "parent",
        canonicalOccurrencePath: parentPath,
        canonicalRefName: "refs/heads/main",
        otherOccurrences: [],
        recordedBaseOid: parentBaseOid,
        targetOid: parentTargetOid,
    };

    const result = publishBases([repo], approvedRunState(), makeRootIntegration(true));

    assert.equal(result.published, true);
    assert.equal(git(parentPath, "rev-parse", "HEAD"), parentTargetOid);
    assert.equal(git(parentPath, "ls-files", "-s", "vendor").split(/\s+/)[1], childTargetOid);
    assert.equal(git(nestedPath, "rev-parse", "HEAD"), childBaseOid);
    assert.equal(readFileSync(join(nestedPath, "child.txt"), "utf8"), "child before\n");
    assert.equal(git(nestedPath, "status", "--short"), "");
    assert.match(git(parentPath, "status", "--short", "--", "vendor"), /vendor$/);
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
