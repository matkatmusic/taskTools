// Behavioral checks for manifestBootstrap.ts: repoRoot -> resolved graph or named refusal. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapRepositoryManifest } from "../scripts/manifestBootstrap.ts";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(): string {
    const repoPath = mkdtempSync(join(tmpdir(), "manifest-bootstrap-"));
    git(repoPath, "init", "-q", "-b", "main");
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function addSubmoduleAt(parentRepoPath: string, submoduleRelativePath: string, originPath: string): void {
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(parentRepoPath, "submodule", "add", "-q", originPath, submoduleRelativePath);
    git(parentRepoPath, "commit", "-q", "-m", `add submodule ${submoduleRelativePath}`);
}

function makeRootWithSubmoduleAtRecordedOid(): string {
    const childOrigin = makeTempRepoWithCommit();
    const rootPath = makeTempRepoWithCommit();
    addSubmoduleAt(rootPath, "child", childOrigin);
    return rootPath;
}

function makeRootWithUnresolvableGitlink(): string {
    const childOrigin = makeTempRepoWithCommit();
    const rootPath = makeTempRepoWithCommit();
    addSubmoduleAt(rootPath, "child", childOrigin);
    const childCheckoutPath = join(rootPath, "child");
    writeFileSync(join(childCheckoutPath, "extra.txt"), "extra\n");
    git(childCheckoutPath, "add", "extra.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "extra");
    return rootPath;
}

test("test_bootstrapReturnsResolvedGraphForRepoWithNoSubmodules", () => {
    const rootPath = makeTempRepoWithCommit();
    const result = bootstrapRepositoryManifest(rootPath);
    assert.equal(result.refused, false);
    if (result.refused) return;
    assert.equal(result.occurrenceGraph.length, 1);
    assert.equal(result.occurrenceGraph[0].occurrenceId, "");
});

test("test_bootstrapResolvesSubmoduleAtRecordedGitlinkOid", () => {
    const rootPath = makeRootWithSubmoduleAtRecordedOid();
    const result = bootstrapRepositoryManifest(rootPath);
    assert.equal(result.refused, false);
    if (result.refused) return;
    assert.equal(result.occurrenceGraph.length, 2);
    const ids = result.occurrenceGraph.map((occurrence) => occurrence.occurrenceId);
    assert.deepEqual(ids.sort(), ["", "child"]);
});

test("test_bootstrapRefusesWithNamedReasonForUnresolvableGitlink", () => {
    const rootPath = makeRootWithUnresolvableGitlink();
    const result = bootstrapRepositoryManifest(rootPath);
    assert.equal(result.refused, true);
    if (!result.refused) return;
    assert.equal(result.requests.length, 1);
    for (const entry of result.requests) {
        assert.equal(typeof entry.reason, "string");
        assert.notEqual(entry.reason, "");
    }
});

test("test_bootstrapPerformsNoGitCheckoutOrBranchCreation", () => {
    const resolvableRoot = makeRootWithSubmoduleAtRecordedOid();
    const unresolvableRoot = makeRootWithUnresolvableGitlink();

    for (const rootPath of [resolvableRoot, unresolvableRoot]) {
        const checkoutPaths = [rootPath, join(rootPath, "child")];
        const headsBefore = checkoutPaths.map((path) => git(path, "rev-parse", "HEAD"));
        const branchesBefore = checkoutPaths.map((path) => git(path, "branch", "--list"));

        bootstrapRepositoryManifest(rootPath);

        checkoutPaths.forEach((path, index) => {
            assert.equal(git(path, "rev-parse", "HEAD"), headsBefore[index]);
            assert.equal(git(path, "branch", "--list"), branchesBefore[index]);
        });
    }
});
