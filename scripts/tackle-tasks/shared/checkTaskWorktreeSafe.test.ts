// Behavioral checks for checkTaskWorktreeSafe.ts. Run alone: node --test tests/checkTaskWorktreeSafe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTaskWorktreeSafe } from "./checkTaskWorktreeSafe.ts";
import { makeLayeredSubmoduleFixture, makeLinkedWorktree } from "../../../tests/support/gitFixtures.ts";

test("test_checkTaskWorktreeSafe_reportsUnsafeWhenHeadIsOnTheWrongBranch", () => {
    // Setup: a real layered-submodule linked worktree created for a task, then switched onto a
    // different branch.
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const groupId = 900_101;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    execFileSync("git", ["-C", worktreePath, "checkout", "-b", "some-other-branch"], { stdio: "ignore" });

    // Test action: check safety.
    const result = checkTaskWorktreeSafe(groupId, worktreePath);

    // Verification: unsafe, and the problem names the wrong branch.
    assert.equal(result.safe, false);
    assert.ok(result.problems.some((problem) => problem.includes("some-other-branch")));
});

test("test_checkTaskWorktreeSafe_reportsSafeWhenTheWorktreeHasUncommittedChanges", () => {
    // Setup: a real layered-submodule linked worktree on its correct task branch, with dirty
    // uncommitted edits.
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const groupId = 900_102;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    writeFileSync(join(worktreePath, "seed.txt"), "dirty edit\n");

    // Test action: check safety.
    const result = checkTaskWorktreeSafe(groupId, worktreePath);

    // Verification: dirty alone is never unsafe (rule 6 — the tree is committed where it matters).
    assert.deepEqual(result, { safe: true, problems: [] });
});

test("test_checkTaskWorktreeSafe_reportsUnsafeWhenAnUninitializedGrandchildSubmoduleIsNested", () => {
    // Setup: a real root -> child -> grandchild worktree, fully populated, then only the
    // grandchild is deinitialized (the direct child stays populated).
    const { rootOrigin } = makeLayeredSubmoduleFixture();
    const groupId = 900_001;
    const worktreePath = makeLinkedWorktree(rootOrigin, groupId);
    execFileSync("git", ["-C", join(worktreePath, "child"), "submodule", "deinit", "-f", "grandchild"], { stdio: "ignore" });

    // Test action: check safety.
    const result = checkTaskWorktreeSafe(groupId, worktreePath);

    // Verification: unsafe, and the problem names the root-relative "child/grandchild" path —
    // a direct-only "git submodule status" would have missed this.
    assert.equal(result.safe, false);
    assert.ok(result.problems.some((problem) => problem.includes("child/grandchild")));
});

test("test_checkTaskWorktreeSafe_reportsUnsafeWhenThePathDoesNotOpenAsAGitWorktree", () => {
    // Setup: a path that is not a git worktree at all.
    const notAWorktree = mkdtempSync(join(tmpdir(), "checkTaskWorktreeSafe-not-git-"));

    // Test action + verification.
    const result = checkTaskWorktreeSafe(1, notAWorktree);
    assert.equal(result.safe, false);
    assert.equal(result.problems.length, 1);
});
