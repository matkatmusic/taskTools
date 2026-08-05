# Task 46: Route repositoryBranches through graph discovery, keeping the detached-HEAD guard in front

Step 1 of the task 35 cutover split.

Rewire scripts/repositoryBranches.ts (collectRepositorySources, submodulePaths, createBranchInEveryRepository) onto the occurrence graph produced by scripts/manifestBootstrap.ts instead of walking submodule paths by hand.

The detached-HEAD refusal stays as the OUTER guard and runs BEFORE discovery, not instead of it: graph discovery resolves a base branch by matching any local branch whose tip equals the recorded gitlink OID, which would wrongly accept a detached submodule because detaching does not move the branch. The existing empty-current-branch check keeps its position and its error keeps naming each offending repository path and telling the user to check out a branch there before continuing.

Discovery is read-only as of task 44, so this must create and check out no branches as a side effect of reading source branches. A bootstrap refusal (needsResolution) must surface as a clean error, not a crash.

Tests: existing tests/repositoryBranches.test.ts keeps passing unchanged; a detached submodule is still refused with its path named; collecting sources creates no branch and leaves every working directory branch unchanged.

### scripts/repositoryBranches.ts

```
// Reads/creates the branch each repository (parent + submodules) should merge back onto.
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export type RepositorySource = {
    path: string; // "" for the parent repo, else the submodule displaypath
    sourceBranch: string;
};

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

export function currentBranchName(repoRoot: string): string {
    return git(repoRoot, "branch", "--show-current");
}

export function submodulePaths(repoRoot: string): string[] {
    const output = execFileSync(
        "git",
        ["-C", repoRoot, "submodule", "--quiet", "foreach", "--recursive", "echo $displaypath"],
        { encoding: "utf8" },
    );
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function collectRepositorySources(repoRoot: string): RepositorySource[] {
    const paths = ["", ...submodulePaths(repoRoot)];
    const detachedPaths: string[] = [];
    const sources: RepositorySource[] = [];
    for (const path of paths) {
        const fullPath = path === "" ? repoRoot : join(repoRoot, path);
        const branch = currentBranchName(fullPath);
        if (branch === "") {
            detachedPaths.push(path === "" ? "(parent)" : path);
            continue;
        }
        sources.push({ path, sourceBranch: branch });
    }
    if (detachedPaths.length > 0) {
        throw new Error(
            `these repositories are on a detached HEAD and cannot be task-branched: ${detachedPaths.join(", ")}`,
        );
    }
    return sources;
}

// -B, not -b: a branch left behind by an earlier run must be reset onto HEAD, never reused as-is.
export function createBranchInEveryRepository(repoRoot: string, paths: string[], branchName: string): void {
    for (const path of paths) {
        git(path === "" ? repoRoot : join(repoRoot, path), "checkout", "-B", branchName);
    }
}

```

### tests/repositoryBranches.test.ts

```
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

```
