# Task 42: Recursive gitlink substitution across a full ancestor chain

Add recursive gitlink substitution to scripts/repositoryIntegration.ts. Today it exports only substituteGitlink(repoRoot, {parentCommitOid, pathInParent, childOid}), which rewrites exactly one gitlink entry in one parent commit via scratch-index tree surgery and returns the new parent commit OID without moving any ref.

Task 29 (recoveryRefs) and later Phase 4 finalization work need to rewrite a whole ancestor chain at once: given a leaf occurrence commit and its full parent chain, substitute the child OID at each level from the bottom up, feeding each new parent commit OID into the next level, and return the new root commit OID plus the new OID at every level.

Add substituteGitlinksRecursively (or the naming convention already in use in that module) taking the ordered chain from root to leaf plus the new leaf OID, folding substituteGitlink over it bottom-up. Reject a chain whose entry is not a gitlink at the named path, reject an empty chain, and keep the no-ref-moved guarantee.

This was split out of task 29: its planner stopped because the recursive primitive its plan assumed does not exist.

Tests: a two-level chain returns a root OID whose tree resolves to the new leaf through both gitlinks; a three-level chain does the same to the root; every intermediate OID is returned; a non-gitlink path in the chain throws; an empty chain is rejected; no branch or base ref moves.

### scripts/repositoryIntegration.ts

```
// Gitlink substitution and prepared no-ff merge primitives. Neither moves a branch or touches a base ref.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type GitlinkSubstitution = {
    parentCommitOid: string;
    pathInParent: string;
    childOid: string;
};

export type RepositoryQualifiedConflict = {
    repoRoot: string;
    conflictedPaths: string[];
};

export type PrepareMergeResult =
    | { merged: true; commitOid: string }
    | { merged: false; conflict: RepositoryQualifiedConflict };

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function gitlinkModeAtPath(repoRoot: string, commitOid: string, path: string): string | null {
    const line = git(repoRoot, "ls-tree", commitOid, "--", path).trim();
    if (line === "") return null;
    return line.split(" ")[0];
}

// Replaces one gitlink entry via scratch-index tree surgery, then commits the new tree. No ref touched.
export function substituteGitlink(repoRoot: string, substitution: GitlinkSubstitution): string {
    const { parentCommitOid, pathInParent, childOid } = substitution;
    if (gitlinkModeAtPath(repoRoot, parentCommitOid, pathInParent) !== "160000") {
        throw new Error(`"${pathInParent}" is not a gitlink in commit ${parentCommitOid}`);
    }
    const scratchIndex = join(tmpdir(), `repo-integration-${randomUUID()}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    try {
        execFileSync("git", ["-C", repoRoot, "read-tree", parentCommitOid], { env });
        execFileSync(
            "git",
            ["-C", repoRoot, "update-index", "--add", "--cacheinfo", `160000,${childOid},${pathInParent}`],
            { env },
        );
        const newTreeOid = execFileSync("git", ["-C", repoRoot, "write-tree"], { encoding: "utf8", env }).trim();
        return git(
            repoRoot,
            "commit-tree",
            newTreeOid,
            "-p",
            parentCommitOid,
            "-m",
            `substitute gitlink at ${pathInParent} -> ${childOid}`,
        ).trim();
    } finally {
        rmSync(scratchIndex, { force: true });
    }
}

// Parses merge-tree conflict output: skip the tree-OID line, take the path from each remaining line.
function parseConflictedPaths(mergeTreeOutput: string): string[] {
    const [fileInfoBlock = ""] = mergeTreeOutput.split("\n\n");
    const [, ...fileInfoLines] = fileInfoBlock.split("\n");
    const paths = fileInfoLines.filter(Boolean).map((line) => line.split("\t")[1]);
    return [...new Set(paths)];
}

// Prepares a --no-ff merge commit via merge-tree plumbing. Returns the commit OID or conflict info.
export function prepareNoFfMerge(
    repoRoot: string,
    baseOid: string,
    tipOid: string,
    message: string,
): PrepareMergeResult {
    try {
        const treeOid = git(repoRoot, "merge-tree", "--write-tree", baseOid, tipOid).trim();
        const commitOid = git(repoRoot, "commit-tree", treeOid, "-p", baseOid, "-p", tipOid, "-m", message).trim();
        return { merged: true, commitOid };
    } catch (error) {
        const stdout = (error as { stdout?: string }).stdout ?? "";
        return { merged: false, conflict: { repoRoot, conflictedPaths: parseConflictedPaths(stdout) } };
    }
}

```

### tests/repositoryIntegration.test.ts

```
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
        .filter((line) => !line.endsWith("\tvendor/child"));
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
        .filter((line) => !line.endsWith("\tvendor/child"));
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

```
