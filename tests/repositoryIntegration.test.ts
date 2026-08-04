// Behavioral checks for repositoryIntegration.ts: gitlink substitution and prepared no-ff merges. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNoFfMerge, substituteGitlink } from "../scripts/repositoryIntegration.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "repo-integration-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

// Builds a parent repo with two gitlinks whose paths share a string prefix: "vendor/child" and "vendor/child2".
function makeParentWithTwoGitlinks(): { parentRoot: string; parentCommit: string; childARoot: string } {
    const childARoot = makeTempRepoWithCommit();
    const childBRoot = makeTempRepoWithCommit();
    const parentRoot = makeTempRepoWithCommit();
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(parentRoot, "submodule", "add", "-q", childARoot, "vendor/child");
    git(parentRoot, "submodule", "add", "-q", childBRoot, "vendor/child2");
    git(parentRoot, "commit", "-q", "-m", "add submodules");
    const parentCommit = git(parentRoot, "rev-parse", "HEAD").trim();
    return { parentRoot, parentCommit, childARoot };
}

test("test_substituteGitlinkChangesOnlyTheDeclaredGitlinkEntry", () => {
    // Scenario: substituting a finalized child OID changes only the declared gitlink entry.
    const { parentRoot, parentCommit, childARoot } = makeParentWithTwoGitlinks();
    writeFileSync(join(childARoot, "seed.txt"), "seed\nchange\n");
    git(childARoot, "commit", "-q", "-am", "change");
    const newChildOid = git(childARoot, "rev-parse", "HEAD").trim();
    // Test action: substitute the new child OID into the parent's "vendor/child" gitlink.
    const newCommit = substituteGitlink(parentRoot, {
        parentCommitOid: parentCommit,
        pathInParent: "vendor/child",
        childOid: newChildOid,
    });
    // Verification: the resulting tree has the new OID at "vendor/child".
    const vendorChildOid = git(parentRoot, "rev-parse", `${newCommit}:vendor/child`).trim();
    assert.equal(vendorChildOid, newChildOid);
});

test("test_substituteGitlinkLeavesSiblingGitlinkWithSharedPathPrefixUnchanged", () => {
    // Scenario: a parent with two gitlinks sharing a string path prefix ("vendor/child", "vendor/child2") — only the declared one changes.
    const { parentRoot, parentCommit, childARoot } = makeParentWithTwoGitlinks();
    const originalSiblingOid = git(parentRoot, "rev-parse", `${parentCommit}:vendor/child2`).trim();
    writeFileSync(join(childARoot, "seed.txt"), "seed\nchange\n");
    git(childARoot, "commit", "-q", "-am", "change");
    const newChildOid = git(childARoot, "rev-parse", "HEAD").trim();
    // Test action: substitute only "vendor/child".
    const newCommit = substituteGitlink(parentRoot, {
        parentCommitOid: parentCommit,
        pathInParent: "vendor/child",
        childOid: newChildOid,
    });
    // Verification: "vendor/child2" is byte-identical to before.
    const siblingOidAfter = git(parentRoot, "rev-parse", `${newCommit}:vendor/child2`).trim();
    assert.equal(siblingOidAfter, originalSiblingOid);
});

test("test_substituteGitlinkLeavesEveryNonGitlinkEntryUnchanged", () => {
    // Scenario: only the declared gitlink entry changes; every other tree entry (blobs, .gitmodules) is byte-identical.
    const { parentRoot, parentCommit, childARoot } = makeParentWithTwoGitlinks();
    const beforeEntries = git(parentRoot, "ls-tree", "-r", parentCommit)
        .split("\n")
        .filter(Boolean)
        .filter((line) => !line.includes("vendor/child\t"));
    writeFileSync(join(childARoot, "seed.txt"), "seed\nchange\n");
    git(childARoot, "commit", "-q", "-am", "change");
    const newChildOid = git(childARoot, "rev-parse", "HEAD").trim();
    // Test action.
    const newCommit = substituteGitlink(parentRoot, {
        parentCommitOid: parentCommit,
        pathInParent: "vendor/child",
        childOid: newChildOid,
    });
    // Verification: every entry other than "vendor/child" is identical.
    const afterEntries = git(parentRoot, "ls-tree", "-r", newCommit)
        .split("\n")
        .filter(Boolean)
        .filter((line) => !line.includes("vendor/child\t"));
    assert.deepEqual(afterEntries, beforeEntries);
});

test("test_substituteGitlinkDoesNotMoveTheCurrentBranchOrHead", () => {
    // Scenario: the substitution primitive never updates a branch ref.
    const { parentRoot, parentCommit, childARoot } = makeParentWithTwoGitlinks();
    const branchBefore = git(parentRoot, "branch", "--show-current").trim();
    const headBefore = git(parentRoot, "rev-parse", "HEAD").trim();
    writeFileSync(join(childARoot, "seed.txt"), "seed\nchange\n");
    git(childARoot, "commit", "-q", "-am", "change");
    const newChildOid = git(childARoot, "rev-parse", "HEAD").trim();
    // Test action.
    substituteGitlink(parentRoot, { parentCommitOid: parentCommit, pathInParent: "vendor/child", childOid: newChildOid });
    // Verification: branch name and HEAD are unchanged.
    assert.equal(git(parentRoot, "branch", "--show-current").trim(), branchBefore);
    assert.equal(git(parentRoot, "rev-parse", "HEAD").trim(), headBefore);
});

test("test_substituteGitlinkThrowsWhenPathInParentIsNotAGitlink", () => {
    // Scenario: input validation at the trust boundary — refuse to touch a path that isn't a gitlink.
    const repoRoot = makeTempRepoWithCommit();
    const commit = git(repoRoot, "rev-parse", "HEAD").trim();
    // Test action + verification: "seed.txt" is a blob, not a gitlink.
    assert.throws(() => {
        substituteGitlink(repoRoot, { parentCommitOid: commit, pathInParent: "seed.txt", childOid: commit });
    });
});

// Builds a repo with a "base" commit, a "feature" branch (non-conflicting change), and leaves HEAD on the base branch.
function makeBaseAndTip(): { repoRoot: string; baseOid: string; tipOid: string } {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "f.txt"), "line1\nline2\nline3\n");
    git(repoRoot, "add", "f.txt");
    git(repoRoot, "commit", "-q", "-m", "add f.txt");
    const baseOid = git(repoRoot, "rev-parse", "HEAD").trim();
    git(repoRoot, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repoRoot, "f.txt"), "line1\nline2-feature\nline3\n");
    git(repoRoot, "commit", "-q", "-am", "feature change");
    const tipOid = git(repoRoot, "rev-parse", "HEAD").trim();
    git(repoRoot, "checkout", "-q", "master");
    return { repoRoot, baseOid, tipOid };
}

test("test_prepareNoFfMergeProducesARealMergeCommitWithTwoParents", () => {
    // Scenario: preparing a no-ff merge from base to tip produces a real merge commit with two parents.
    const { repoRoot, baseOid, tipOid } = makeBaseAndTip();
    // Test action.
    const result = prepareNoFfMerge(repoRoot, baseOid, tipOid, "merge feature");
    // Verification.
    assert.equal(result.merged, true);
    if (!result.merged) return;
    const parents = git(repoRoot, "log", "-1", "--format=%P", result.commitOid).trim().split(" ");
    assert.deepEqual(parents, [baseOid, tipOid]);
});

test("test_prepareNoFfMergeLeavesRefsHeadsProvablyUnchangedBeforeAndAfter", () => {
    // Scenario: preparing the merge commit never moves any branch ref.
    const { repoRoot, baseOid, tipOid } = makeBaseAndTip();
    const branchesBefore = git(repoRoot, "for-each-ref", "refs/heads");
    // Test action.
    prepareNoFfMerge(repoRoot, baseOid, tipOid, "merge feature");
    // Verification: refs/heads is byte-identical before and after.
    const branchesAfter = git(repoRoot, "for-each-ref", "refs/heads");
    assert.equal(branchesAfter, branchesBefore);
});

test("test_prepareNoFfMergeReturnsRepositoryQualifiedConflictInfoOnConflict", () => {
    // Scenario: a conflicting merge returns repository-qualified conflict information instead of a commit OID.
    const { repoRoot, tipOid } = makeBaseAndTip();
    writeFileSync(join(repoRoot, "f.txt"), "line1\nline2-main\nline3\n");
    git(repoRoot, "commit", "-q", "-am", "conflicting base change");
    const conflictingBaseOid = git(repoRoot, "rev-parse", "HEAD").trim();
    // Test action.
    const result = prepareNoFfMerge(repoRoot, conflictingBaseOid, tipOid, "merge feature");
    // Verification: conflict info names this repository and the conflicted path.
    assert.equal(result.merged, false);
    if (result.merged) return;
    assert.equal(result.conflict.repoRoot, repoRoot);
    assert.deepEqual(result.conflict.conflictedPaths, ["f.txt"]);
});

test("test_prepareNoFfMergeMovesNothingOnConflict", () => {
    // Scenario: a conflicting merge leaves refs and working tree untouched — no half-finished state.
    const { repoRoot, tipOid } = makeBaseAndTip();
    writeFileSync(join(repoRoot, "f.txt"), "line1\nline2-main\nline3\n");
    git(repoRoot, "commit", "-q", "-am", "conflicting base change");
    const conflictingBaseOid = git(repoRoot, "rev-parse", "HEAD").trim();
    const branchesBefore = git(repoRoot, "for-each-ref", "refs/heads");
    // Test action.
    prepareNoFfMerge(repoRoot, conflictingBaseOid, tipOid, "merge feature");
    // Verification: refs/heads unchanged, no in-progress merge state, clean working tree.
    assert.equal(git(repoRoot, "for-each-ref", "refs/heads"), branchesBefore);
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
    assert.equal(git(repoRoot, "status", "--porcelain").trim(), "");
});
