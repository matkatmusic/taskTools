// Behavioral checks for stagingWorktree.ts. Run: node --test scripts/tackle-tasks/shared/stagingWorktree.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureStagingWorktree, stagingWorktreePath } from "./stagingWorktree.ts";
import { loadRepositoryManifest } from "../../shared/prepareTasks.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempRepoWithTestScript(branchName: string): string {
    const repoPath = tmpMkdir("staging-worktree-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeTempRepoWithTestScript("child-main");
    const rootOrigin = makeTempRepoWithTestScript("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return rootOrigin;
}

test("test_ensureStagingWorktree_addsALinkedWorktreeOnTheSourceBranch", () => {
    const repo = makeTempRepoWithTestScript("main");
    git(repo, "branch", "staging");

    ensureStagingWorktree(repo, "staging");

    const path = stagingWorktreePath(repo);
    assert.equal(existsSync(path), true);
    assert.equal(git(path, "branch", "--show-current"), "staging");
    assert.equal(git(repo, "branch", "--show-current"), "main");
    assert.equal(git(repo, "worktree", "list", "--porcelain").includes(realpathSync(path)), true);
});

test("test_ensureStagingWorktree_addsANestedLinkedWorktreePerSubmodule", () => {
    const repo = makeSourceRepoWithSubmodule();
    git(repo, "branch", "staging");

    ensureStagingWorktree(repo, "staging");

    const path = stagingWorktreePath(repo);
    assert.equal(statSync(join(path, "child", ".git")).isFile(), true);
    assert.equal(
        git(join(repo, "child"), "worktree", "list", "--porcelain").includes(realpathSync(join(path, "child"))),
        true,
    );
    assert.equal(git(join(path, "child"), "branch", "--show-current"), "staging");
});

test("test_ensureStagingWorktree_doesNothingWhenTheWorktreeExists", () => {
    const repo = makeTempRepoWithTestScript("main");
    git(repo, "branch", "staging");

    ensureStagingWorktree(repo, "staging");
    assert.doesNotThrow(() => ensureStagingWorktree(repo, "staging"));

    const path = stagingWorktreePath(repo);
    const worktreeBlocks = git(repo, "worktree", "list", "--porcelain").split("\n\n").filter((block) => block.includes(realpathSync(path)));
    assert.equal(worktreeBlocks.length, 1);
});

test("test_ensureStagingWorktree_refusesWhenTheWorktreeIsOnAnotherBranch", () => {
    const repo = makeTempRepoWithTestScript("main");
    git(repo, "branch", "staging");
    ensureStagingWorktree(repo, "staging");
    const path = stagingWorktreePath(repo);
    git(path, "checkout", "-b", "wrong");

    assert.throws(
        () => ensureStagingWorktree(repo, "staging"),
        (error: Error) => error.message.includes("wrong") && error.message.includes("staging"),
    );
});
