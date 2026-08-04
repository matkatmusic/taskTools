// Behavioral checks for operationPush.ts: canonical-only push, no force, ancestor gate, verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogicalRepository } from "../scripts/logicalRepository.ts";
import type { RepositoryOccurrence } from "../scripts/repositoryManifest.ts";
import { issueRunAuthorization } from "../scripts/runAuthorization.ts";
import {
    NonAncestorRemoteTipError,
    OccurrenceVerificationMismatchError,
    RunNotApprovedError,
    buildPushArgv,
    pushOperationBranches,
} from "../scripts/operationPush.ts";

const AUTH_DIGEST = "digest-a";
const token = issueRunAuthorization(AUTH_DIGEST);

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempGitRepo(prefix: string): string {
    const repoPath = mkdtempSync(join(tmpdir(), prefix));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    return repoPath;
}

function makeBareGitRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "operation-push-remote-"));
    git(repoPath, "init", "-q", "--bare", "-b", "main");
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
        originUrl: "",
        baseBranch: "main",
        baseOid: "0".repeat(40),
        operationBranch: "op-branch",
        childOccurrenceIds: [],
        testState: "untested",
        ...overrides,
    };
}

function makeLogicalRepository(overrides: Partial<LogicalRepository>): LogicalRepository {
    return {
        normalizedIdentity: { host: "example.com", owner: "acme", repository: "widgets" },
        occurrenceIds: ["root"],
        selectedBaseOccurrenceId: "root",
        canonicalOccurrenceId: "root",
        lastWriterOccurrenceId: "root",
        convergenceDigest: "digest",
        consolidationState: "single",
        ...overrides,
    };
}

test("test_uniqueRepositoryOperationBranchIsNotPushed", async () => {
    const bareRemote = makeBareGitRepo();
    const repoPath = makeTempGitRepo("operation-push-unique-");
    commit(repoPath, "a.txt");
    git(repoPath, "branch", "op-branch");
    const occurrence = makeOccurrence({ checkoutPath: repoPath, originUrl: bareRemote });
    const logicalRepository = makeLogicalRepository({ occurrenceIds: ["root"], canonicalOccurrenceId: "root" });

    const results = await pushOperationBranches(
        { logicalRepositories: [logicalRepository], occurrences: [occurrence] },
        token,
        AUTH_DIGEST,
    );

    assert.equal(results.length, 1);
    assert.equal(results[0].kind, "skipped-unique");
    assert.equal(git(bareRemote, "for-each-ref", "refs/heads/op-branch"), "");
});

test("test_repeatedRepositoryPushesOnlyCanonicalBranch", async () => {
    const bareRemote = makeBareGitRepo();
    const canonicalPath = makeTempGitRepo("operation-push-canonical-");
    const oid = commit(canonicalPath, "a.txt");
    git(canonicalPath, "branch", "op-branch");
    const otherPath = makeTempGitRepo("operation-push-other-");
    git(otherPath, "fetch", canonicalPath, "main");
    git(otherPath, "branch", "op-branch", "FETCH_HEAD");

    const canonicalOccurrence = makeOccurrence({ occurrenceId: "canonical", checkoutPath: canonicalPath, originUrl: bareRemote });
    const otherOccurrence = makeOccurrence({ occurrenceId: "other", checkoutPath: otherPath, originUrl: bareRemote });
    const logicalRepository = makeLogicalRepository({ occurrenceIds: ["canonical", "other"], canonicalOccurrenceId: "canonical", consolidationState: "grouped" });

    const results = await pushOperationBranches(
        { logicalRepositories: [logicalRepository], occurrences: [canonicalOccurrence, otherOccurrence] },
        token,
        AUTH_DIGEST,
    );

    assert.equal(results.length, 1);
    assert.deepEqual(results[0], { kind: "pushed", convergenceDigest: logicalRepository.convergenceDigest, oid });
    assert.equal(git(bareRemote, "for-each-ref", "refs/heads/op-branch").split("\n").length, 1);
    assert.equal(git(bareRemote, "rev-parse", "refs/heads/op-branch"), oid);
});

test("test_nonAncestorRemoteTipAbortsBeforePublication", async () => {
    const bareRemote = makeBareGitRepo();
    const canonicalPath = makeTempGitRepo("operation-push-divergent-");
    const oid = commit(canonicalPath, "a.txt");
    git(canonicalPath, "branch", "op-branch");

    const divergentSource = makeTempGitRepo("operation-push-divergent-source-");
    const divergentOid = commit(divergentSource, "b.txt");
    git(bareRemote, "fetch", divergentSource, `main:refs/heads/op-branch`);
    assert.equal(git(bareRemote, "rev-parse", "refs/heads/op-branch"), divergentOid);

    const occurrence = makeOccurrence({ occurrenceId: "canonical", checkoutPath: canonicalPath, originUrl: bareRemote });
    const logicalRepository = makeLogicalRepository({ occurrenceIds: ["canonical", "other"], canonicalOccurrenceId: "canonical", consolidationState: "grouped" });
    const otherOccurrence = makeOccurrence({ occurrenceId: "other", checkoutPath: divergentSource, originUrl: bareRemote });

    await assert.rejects(
        () =>
            pushOperationBranches(
                { logicalRepositories: [logicalRepository], occurrences: [occurrence, otherOccurrence] },
                token,
                AUTH_DIGEST,
            ),
        NonAncestorRemoteTipError,
    );
    assert.equal(git(bareRemote, "rev-parse", "refs/heads/op-branch"), divergentOid);
    assert.notEqual(oid, divergentOid);
});

test("test_noPushUsesForceUnderAnyPath", () => {
    const argv = buildPushArgv("origin", "a".repeat(40), "tackle-op/run1/root");
    assert.deepEqual(argv, ["push", "origin", `${"a".repeat(40)}:refs/heads/tackle-op/run1/root`]);
    assert.equal(argv.includes("-f"), false);
    assert.equal(argv.includes("--force"), false);
});

test("test_afterPushEveryOtherOccurrenceVerifiesSameOidAndTree", async () => {
    const bareRemote = makeBareGitRepo();
    const canonicalPath = makeTempGitRepo("operation-push-verify-canonical-");
    const oid = commit(canonicalPath, "a.txt");
    git(canonicalPath, "branch", "op-branch");
    const otherPath = makeTempGitRepo("operation-push-verify-other-");
    git(otherPath, "fetch", canonicalPath, "main");
    git(otherPath, "branch", "op-branch", "FETCH_HEAD");

    const canonicalOccurrence = makeOccurrence({ occurrenceId: "canonical", checkoutPath: canonicalPath, originUrl: bareRemote });
    const otherOccurrence = makeOccurrence({ occurrenceId: "other", checkoutPath: otherPath, originUrl: bareRemote });
    const logicalRepository = makeLogicalRepository({ occurrenceIds: ["canonical", "other"], canonicalOccurrenceId: "canonical", consolidationState: "grouped" });

    await pushOperationBranches(
        { logicalRepositories: [logicalRepository], occurrences: [canonicalOccurrence, otherOccurrence] },
        token,
        AUTH_DIGEST,
    );

    const canonicalTree = git(canonicalPath, "rev-parse", `${oid}^{tree}`);
    assert.equal(git(otherPath, "rev-parse", "FETCH_HEAD"), oid);
    assert.equal(git(otherPath, "rev-parse", "FETCH_HEAD^{tree}"), canonicalTree);
});

test("test_pushAttemptedBeforeApprovalFails", async () => {
    const bareRemote = makeBareGitRepo();
    const canonicalPath = makeTempGitRepo("operation-push-unapproved-");
    commit(canonicalPath, "a.txt");
    git(canonicalPath, "branch", "op-branch");
    const otherPath = makeTempGitRepo("operation-push-unapproved-other-");

    const canonicalOccurrence = makeOccurrence({ occurrenceId: "canonical", checkoutPath: canonicalPath, originUrl: bareRemote });
    const otherOccurrence = makeOccurrence({ occurrenceId: "other", checkoutPath: otherPath, originUrl: bareRemote });
    const logicalRepository = makeLogicalRepository({ occurrenceIds: ["canonical", "other"], canonicalOccurrenceId: "canonical", consolidationState: "grouped" });

    await assert.rejects(
        () =>
            pushOperationBranches(
                { logicalRepositories: [logicalRepository], occurrences: [canonicalOccurrence, otherOccurrence] },
                token,
                "wrong-digest",
            ),
        RunNotApprovedError,
    );
    assert.equal(git(bareRemote, "for-each-ref", "refs/heads/op-branch"), "");
});
