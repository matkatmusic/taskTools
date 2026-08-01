// Behavioral checks for repositoryBranches.ts: submodule discovery, source branches, branch creation. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    collectRepositorySources,
    createBranchInEveryRepository,
    currentBranchName,
    submodulePaths,
} from "../scripts/repositoryBranches.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "repository-branches-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function makeTempRepoWithLocalSubmodule(): { repoRoot: string; submoduleOrigin: string } {
    const submoduleOrigin = makeTempRepoWithCommit();
    writeFileSync(join(submoduleOrigin, "inner.txt"), "SUBMODULE-MARKER\n");
    git(submoduleOrigin, "add", "inner.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "inner");
    const repoRoot = makeTempRepoWithCommit();
    // git >=2.38 blocks file-transport submodules; repo config is ignored here, env is not.
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(repoRoot, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(repoRoot, "commit", "-q", "-m", "add submodule");
    return { repoRoot, submoduleOrigin };
}

test("test_submodulePathsListsTheParentRepositorysSubmodules", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    assert.deepEqual(submodulePaths(repoRoot), ["vendor"]);
    const noSubmodulesRepo = makeTempRepoWithCommit();
    assert.deepEqual(submodulePaths(noSubmodulesRepo), []);
});

test("test_collectRepositorySourcesIncludesTheParentAndEverySubmodule", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const parentBranch = currentBranchName(repoRoot);
    const submoduleBranch = currentBranchName(join(repoRoot, "vendor"));
    const sources = collectRepositorySources(repoRoot);
    assert.deepEqual(
        sources.find((source) => source.path === ""),
        { path: "", sourceBranch: parentBranch },
    );
    assert.deepEqual(
        sources.find((source) => source.path === "vendor"),
        { path: "vendor", sourceBranch: submoduleBranch },
    );
});

test("test_collectRepositorySourcesThrowsNamingEveryDetachedRepository", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    git(join(repoRoot, "vendor"), "checkout", "--detach", "HEAD");
    assert.throws(() => collectRepositorySources(repoRoot), /vendor/);

    const { repoRoot: parentDetachedRepo } = makeTempRepoWithLocalSubmodule();
    git(parentDetachedRepo, "checkout", "--detach", "HEAD");
    assert.throws(() => collectRepositorySources(parentDetachedRepo), /\(parent\)/);
});

test("test_createBranchInEveryRepositoryChecksOutTheBranchInParentAndSubmodule", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    git(join(repoRoot, "vendor"), "checkout", "--detach", "HEAD");
    createBranchInEveryRepository(repoRoot, ["", "vendor"], "task-group-1");
    assert.equal(currentBranchName(repoRoot), "task-group-1");
    assert.equal(currentBranchName(join(repoRoot, "vendor")), "task-group-1");
});

test("test_createBranchInEveryRepositoryIsIdempotentWhenTheBranchAlreadyExists", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    createBranchInEveryRepository(repoRoot, ["", "vendor"], "task-group-1");
    assert.doesNotThrow(() => createBranchInEveryRepository(repoRoot, ["", "vendor"], "task-group-1"));
});
