// Behavioral checks for recoveryRefs.ts: run-scoped recovery snapshots after worker/sync checkpoints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    recoveryRefName,
    snapshotSyncRecovery,
    snapshotWorkerRecovery,
} from "../scripts/recoveryRefs.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "recovery-refs-"));
    git(repoRoot, "init", "-q", "-b", "main");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function treeAtRef(repoPath: string, ref: string): string {
    return git(repoPath, "rev-parse", `${ref}^{tree}`);
}

test("test_recoveryRefName_buildsWorkerRefPath", () => {
    assert.equal(recoveryRefName("run-1", "worker", "worker-a"), "refs/recovery/run-1/worker/worker-a");
});

test("test_recoveryRefName_buildsSyncRefPath", () => {
    assert.equal(recoveryRefName("run-1", "sync", "round-2"), "refs/recovery/run-1/sync/round-2");
});

test("test_snapshotWorkerRecovery_createsResolvableRef", async () => {
    const repoRoot = makeTempRepoWithCommit();
    await snapshotWorkerRecovery(repoRoot, "run-1", "worker-a");
    const ref = recoveryRefName("run-1", "worker", "worker-a");
    const files = git(repoRoot, "ls-tree", "-r", "--name-only", `${ref}^{tree}`);
    assert.ok(files.split("\n").includes("seed.txt"));
});

test("test_snapshotSyncRecovery_createsResolvableRef", async () => {
    const repoRoot = makeTempRepoWithCommit();
    await snapshotWorkerRecovery(repoRoot, "run-2", "worker-a");
    await snapshotSyncRecovery(repoRoot, "run-2", "round-1");
    const workerRef = recoveryRefName("run-2", "worker", "worker-a");
    const syncRef = recoveryRefName("run-2", "sync", "round-1");
    assert.notEqual(git(repoRoot, "rev-parse", workerRef), "");
    assert.notEqual(git(repoRoot, "rev-parse", syncRef), "");
});

test("test_snapshotRecovery_capturesUncommittedWorkerChanges", async () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "seed.txt"), "modified\n");
    writeFileSync(join(repoRoot, "untracked.txt"), "new file\n");
    await snapshotWorkerRecovery(repoRoot, "run-3", "worker-a");
    const ref = recoveryRefName("run-3", "worker", "worker-a");
    const seedContent = git(repoRoot, "show", `${ref}:seed.txt`);
    const untrackedContent = git(repoRoot, "show", `${ref}:untracked.txt`);
    assert.equal(seedContent, "modified");
    assert.equal(untrackedContent, "new file");
});

test("test_snapshotRecovery_leavesRealIndexAndWorkingTreeUntouched", async () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "seed.txt"), "modified\n");
    writeFileSync(join(repoRoot, "untracked.txt"), "new file\n");
    const before = git(repoRoot, "status", "--porcelain");
    await snapshotWorkerRecovery(repoRoot, "run-4", "worker-a");
    const after = git(repoRoot, "status", "--porcelain");
    assert.equal(after, before);
});

test("test_snapshotRecovery_leavesOperationAndBaseBranchesUnmoved", async () => {
    const repoRoot = makeTempRepoWithCommit();
    git(repoRoot, "checkout", "-q", "-b", "task-group-1");
    const baseSha = git(repoRoot, "rev-parse", "main");
    const operationSha = git(repoRoot, "rev-parse", "task-group-1");

    await snapshotWorkerRecovery(repoRoot, "run-5", "worker-a");
    await snapshotSyncRecovery(repoRoot, "run-5", "round-1");

    assert.equal(git(repoRoot, "rev-parse", "main"), baseSha);
    assert.equal(git(repoRoot, "rev-parse", "task-group-1"), operationSha);
});

test("test_snapshotRecovery_isIdempotentOnRepeatedCalls", async () => {
    const repoRoot = makeTempRepoWithCommit();
    await snapshotWorkerRecovery(repoRoot, "run-6", "worker-a");
    const ref = recoveryRefName("run-6", "worker", "worker-a");
    const firstTree = treeAtRef(repoRoot, ref);

    await assert.doesNotReject(snapshotWorkerRecovery(repoRoot, "run-6", "worker-a"));
    const secondTree = treeAtRef(repoRoot, ref);

    assert.equal(secondTree, firstTree);
    const leftoverIndexes = readdirSync(join(repoRoot, ".git")).filter((name) => name.startsWith("recovery-"));
    assert.deepEqual(leftoverIndexes, []);
});

test("test_snapshotRecovery_reachesNestedOccurrenceContentThroughGitlink", async () => {
    const nestedOrigin = makeTempRepoWithCommit();
    const repoRoot = makeTempRepoWithCommit();
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(repoRoot, "submodule", "add", "-q", nestedOrigin, "nested");
    git(repoRoot, "commit", "-q", "-m", "add nested submodule");
    writeFileSync(join(repoRoot, "nested", "seed.txt"), "nested modified\n");

    await snapshotWorkerRecovery(repoRoot, "run-7", "worker-a");
    const ref = recoveryRefName("run-7", "worker", "worker-a");
    const gitlinkOid = git(repoRoot, "rev-parse", `${ref}:nested`);

    execFileSync("git", ["-C", join(repoRoot, "nested"), "cat-file", "-e", gitlinkOid]);
    const nestedSeedContent = git(join(repoRoot, "nested"), "show", `${gitlinkOid}:seed.txt`);
    assert.equal(nestedSeedContent, "nested modified");
});
