// Behavioral checks for gitlinkReader.ts: direct-gitlink discovery via `git ls-tree -r`. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDirectGitlinks } from "../scripts/gitlinkReader.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "gitlink-reader-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function makeParentRepoWithGitlinks(): {
    parentRoot: string;
    parentCommit: string;
    singleSegmentOid: string;
    multiSegmentOid: string;
} {
    const vendorOrigin = makeTempRepoWithCommit();
    const externalOrigin = makeTempRepoWithCommit();
    const parentRoot = makeTempRepoWithCommit();
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(parentRoot, "submodule", "add", "-q", vendorOrigin, "vendor");
    git(parentRoot, "submodule", "add", "-q", externalOrigin, "external/tmux_lib");
    git(parentRoot, "commit", "-q", "-m", "add submodules");
    const parentCommit = git(parentRoot, "rev-parse", "HEAD").trim();
    const singleSegmentOid = git(parentRoot, "rev-parse", "HEAD:vendor").trim();
    const multiSegmentOid = git(parentRoot, "rev-parse", "HEAD:external/tmux_lib").trim();
    return { parentRoot, parentCommit, singleSegmentOid, multiSegmentOid };
}

test("test_readDirectGitlinksReturnsBothDirectChildrenWithCorrectOids", () => {
    const { parentRoot, parentCommit, singleSegmentOid, multiSegmentOid } = makeParentRepoWithGitlinks();
    const result = readDirectGitlinks(parentRoot, parentCommit).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(result, [
        { path: "external/tmux_lib", oid: multiSegmentOid },
        { path: "vendor", oid: singleSegmentOid },
    ]);
});

test("test_readDirectGitlinksReturnsEmptyListWhenRepoHasNoGitlinks", () => {
    const repoRoot = makeTempRepoWithCommit();
    assert.deepEqual(readDirectGitlinks(repoRoot, "HEAD"), []);
});

test("test_readDirectGitlinksExcludesIntermediateDirectoriesFromResult", () => {
    const { parentRoot, parentCommit } = makeParentRepoWithGitlinks();
    const result = readDirectGitlinks(parentRoot, parentCommit);
    assert.equal(result.some((entry) => entry.path === "external"), false);
});

test("test_readDirectGitlinksExcludesGrandchildGitlinksInsideAChildRepository", () => {
    const { parentRoot, parentCommit } = makeParentRepoWithGitlinks();
    const nestedOrigin = makeTempRepoWithCommit();
    const vendorOrigin = join(parentRoot, "vendor");
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(vendorOrigin, "submodule", "add", "-q", nestedOrigin, "nested");
    git(vendorOrigin, "commit", "-q", "-m", "add nested submodule");

    const result = readDirectGitlinks(parentRoot, parentCommit);
    assert.equal(result.some((entry) => entry.path.includes("nested")), false);
});
