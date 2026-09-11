// A staging worktree left on a stale branch rebuilds when clean, but still refuses when dirty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./support/gitFixtures.ts";
import { makeShapeFixture } from "./support/repoShapeFixtures.ts";
import { ensureStagingWorktree, stagingWorktreePath } from "../scripts/tackle-tasks/shared/stagingWorktree.ts";

test("test_ensureStagingWorktree_rebuildsAStaleSubmoduleWorktreeWhenClean_ButRefusesWhenDirty", () => {
    const fixture = makeShapeFixture("one-submodule", "at-head", 501);

    ensureStagingWorktree(fixture.rootPath, "staging");

    const stagingRoot = stagingWorktreePath(fixture.rootPath);
    const subWorktreePath = join(stagingRoot, "sub");
    git(subWorktreePath, "checkout", "-q", "-B", "oldbase");

    assert.doesNotThrow(() => ensureStagingWorktree(fixture.rootPath, "staging"));
    assert.equal(git(subWorktreePath, "branch", "--show-current"), "");
    assert.equal(
        git(subWorktreePath, "rev-parse", "HEAD"),
        git(stagingRoot, "rev-parse", "HEAD:sub"),
        "rebuilt submodule worktree must be detached at the parent's recorded gitlink",
    );

    git(subWorktreePath, "checkout", "-q", "-B", "oldbase");
    writeFileSync(join(subWorktreePath, "dirty.txt"), "dirty\n");

    assert.throws(
        () => ensureStagingWorktree(fixture.rootPath, "staging"),
        (error: Error) => error.message.includes('is on "oldbase"'),
    );
});
