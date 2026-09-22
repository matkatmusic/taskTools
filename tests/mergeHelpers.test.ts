// Real-git tests for mergeHeadIntoStaging: a clean diverged merge and a conflicted one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, makeCommittedRepo } from "./support/gitFixtures.ts";
import { mergeHeadIntoStaging } from "../scripts/shared/mergeHelpers.ts";

test("test_mergeHelpers_returnsTheMergedTipOnACleanDivergedMerge", () => {
    // Setup: a repo on "main" with a "staging" branch cut from the seed commit.
    const repoRoot = makeCommittedRepo("merge-helpers-clean-", "main");
    git(repoRoot, "branch", "staging");
    // staging gains one commit that adds staging.txt.
    git(repoRoot, "checkout", "-q", "staging");
    writeFileSync(join(repoRoot, "staging.txt"), "staging side\n");
    git(repoRoot, "add", "staging.txt");
    git(repoRoot, "commit", "-q", "-m", "staging side");
    // main gains one commit that adds head.txt, so the two branches diverge without a conflict.
    git(repoRoot, "checkout", "-q", "main");
    writeFileSync(join(repoRoot, "head.txt"), "head side\n");
    git(repoRoot, "add", "head.txt");
    git(repoRoot, "commit", "-q", "-m", "head side");
    const headTip = git(repoRoot, "rev-parse", "HEAD");
    const mergeWorktreePath = join(mkdtempSync(join(tmpdir(), "merge-helpers-clean-wt-")), "merge");

    // Action: merge HEAD into staging in the caller-supplied worktree.
    const mergeResult = mergeHeadIntoStaging(repoRoot, headTip, "refs/heads/staging", mergeWorktreePath);

    // Verify: the result is a commit hash, and that commit holds the file HEAD added.
    assert.equal(typeof mergeResult, "string");
    assert.match(mergeResult as string, /^[0-9a-f]{40}$/);
    assert.equal(git(repoRoot, "show", `${mergeResult as string}:head.txt`), "head side");
});

test("test_mergeHelpers_returnsAConflictSignalAndLeavesTheWorktreeInPlace", () => {
    // Setup: a repo on "main" with a "staging" branch cut from the seed commit.
    const repoRoot = makeCommittedRepo("merge-helpers-conflict-", "main");
    git(repoRoot, "branch", "staging");
    // staging changes the one line of seed.txt.
    git(repoRoot, "checkout", "-q", "staging");
    writeFileSync(join(repoRoot, "seed.txt"), "staging line\n");
    git(repoRoot, "commit", "-q", "-am", "staging edits seed");
    // main changes the same line of seed.txt, so the merge conflicts.
    git(repoRoot, "checkout", "-q", "main");
    writeFileSync(join(repoRoot, "seed.txt"), "head line\n");
    git(repoRoot, "commit", "-q", "-am", "head edits seed");
    const headTip = git(repoRoot, "rev-parse", "HEAD");
    const mergeWorktreePath = join(mkdtempSync(join(tmpdir(), "merge-helpers-conflict-wt-")), "merge");

    // Action: merge HEAD into staging in the caller-supplied worktree.
    const mergeResult = mergeHeadIntoStaging(repoRoot, headTip, "refs/heads/staging", mergeWorktreePath);

    // Verify: the result is the conflict signal with no file list.
    assert.deepEqual(mergeResult, { conflict: true });
    // Verify: the merge worktree is still on disk.
    assert.equal(existsSync(mergeWorktreePath), true);
    // Verify: git still reports seed.txt as unmerged there, so no cleanup ran.
    assert.equal(git(mergeWorktreePath, "status", "--porcelain"), "UU seed.txt");
});
