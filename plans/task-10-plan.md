# Task 10 Plan: `scripts/repositoryIntegration.ts` — gitlink substitution + prepared no-ff merge

## What this delivers

Two standalone git-plumbing primitives, each pure with respect to repository state (no branch move, no base-ref touch, no half-finished state on failure). Phase 3 (a later task) will wire these into the occurrence-graph traversal; this task only delivers the primitives + their tests, operating on raw git identifiers (commit OIDs, paths) rather than on `RepositoryOccurrence`/`RepositoryManifest` objects from `scripts/repositoryManifest.ts` / `scripts/repositoryGraph.ts`. Do not import those modules here — keeps the primitives testable in isolation, matches the brief's "Phase 3 composes these" framing.

Both primitives were prototyped and run end-to-end against real repos before writing this plan (creating gitlinks with `git submodule add`, running the two functions, inspecting `git ls-tree`/`git log`/`git branch` before and after). The exact code below is the validated, working implementation — copy it as-is; the only work left is placing it in the two files and confirming the tests run green.

## Order of work

1. Create `tests/repositoryIntegration.test.ts` (RED — it will fail to even import, since `scripts/repositoryIntegration.ts` does not exist yet).
2. Create `scripts/repositoryIntegration.ts` with the two primitives (GREEN).
3. Run `node --test tests/repositoryIntegration.test.ts` (or `bun test tests/repositoryIntegration.test.ts` — both runners work in this repo) until every test passes.
4. Run `node --test 'tests/*.test.ts'` to confirm nothing else regressed (this is a brand-new module with no call sites yet, so it should be additive-only).

## Design notes (the "why", so the two primitives below make sense)

- **Gitlink substitution** is implemented as index surgery, not a working-tree checkout: `git read-tree <parentCommitOid>` into a **scratch index file** (`GIT_INDEX_FILE` env override, unique temp path — never the repo's real index), `git update-index --add --cacheinfo 160000,<childOid>,<pathInParent>` to replace just that one entry, `git write-tree` to get the new tree OID, then `git commit-tree <newTree> -p <parentCommitOid> -m ...` to produce a real, single-parent, dangling commit. No working directory is touched, no ref moves — `git commit-tree` never updates HEAD or any branch. This also naturally handles nested gitlink paths (e.g. `vendor/child`) correctly, and confirmed by prototype: when two gitlinks share a string prefix (`vendor/child` and `vendor/child2`), only the exact declared path changes because index entries are keyed by exact path, not prefix.
- A guard (`gitlinkModeAtPath`) checks the entry at `pathInParent` in `parentCommitOid` really is mode `160000` before touching anything, and throws otherwise — this is a trust-boundary input check (wrong path/mode would otherwise silently corrupt the tree via `--add`).
- **Prepared no-ff merge** uses `git merge-tree --write-tree <baseOid> <tipOid>` (git ≥2.38 plumbing merge, confirmed available: this environment runs git 2.55.0). On success this prints exactly one line: the resulting tree OID. Wrap it with `git commit-tree <tree> -p <baseOid> -p <tipOid> -m <message>` to get a real two-parent merge commit — again, no ref is ever read from or written to; `baseOid`/`tipOid` are passed as OIDs, not branch names, so there is nothing for git to move.
- On conflict, `git merge-tree` exits non-zero and `execFileSync` throws; the thrown error's `.stdout` still contains the structured output: line 1 is a tree OID (for a tree containing conflict markers — harmless dangling object, not a ref, safe to ignore), a blank-line-separated block of `<mode> <oid> <stage>\t<path>` lines (one per conflicting file per stage), then informational messages. `parseConflictedPaths` drops the first line and pulls the path (text after the tab) from each remaining line up to the first blank line, de-duplicating (a given path appears once per stage, 2-3 times). No commit is ever created for a conflicting merge, so nothing is half-finished.
- Both primitives were confirmed via prototype to leave `git branch --show-current`, `git rev-parse HEAD`, and `git status --porcelain` unchanged before vs. after, in both the success and conflict paths.

## `scripts/repositoryIntegration.ts` (create with exactly this content)

```ts
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

## `tests/repositoryIntegration.test.ts` (create with exactly this content)

This follows the fixture pattern already used by `tests/gitlinkReader.test.ts` and `tests/mergeTaskWorktrees.test.ts` (a local `git()` exec helper + `makeTempRepoWithCommit`), plus local helpers for building a parent-with-gitlinks repo and a base/tip pair.

```ts
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
```

## Verification

1. `node --test tests/repositoryIntegration.test.ts` — all 10 tests green. (Every test in this file was hand-verified against the exact implementation above via a throwaway script before writing this plan: substitution changes only the declared entry, the shared-prefix sibling is untouched, branch/HEAD never move, the guard throws on a non-gitlink path, the merge produces a real 2-parent commit, `refs/heads` is provably unchanged in both the success and conflict paths, and a conflict returns `{ repoRoot, conflictedPaths }` with no `MERGE_HEAD` and a clean working tree.)
2. `node --test 'tests/*.test.ts'` — confirm no regressions (this module has no existing call sites, so it's additive only).

## Explicit non-goals (do not implement here)

- No wiring into `scripts/repositoryGraph.ts`, `scripts/repositoryManifest.ts`, or any workflow/CLI entry point — that composition is Phase 3's job, per the brief.
- No `runAsCli()` / CLI entry point for this module — nothing in the brief calls for one, and no sibling task references invoking it as a script (unlike `mergeTaskWorktrees.ts`, which is genuinely invoked as a CLI from the workflow). Add one only when Phase 3 needs it.
