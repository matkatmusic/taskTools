// Real-git tests for catchUpStaging: staging behind, staging diverged and clean, staging diverged with a conflict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./support/gitFixtures.ts";
import { makeShapeFixture } from "./support/repoShapeFixtures.ts";
import { resolveTaskWorktreeConventionDirectory } from "../scripts/shared/prepareTasks.ts";
import { catchUpStaging } from "../scripts/shared/catchUpStaging.ts";

test("test_catchUpStaging_movesStagingWithNoMergeWorktreeWhenStagingIsBehind", () => {
    // Setup: a root with one submodule; in both repositories, staging is one commit behind main.
    const fixture = makeShapeFixture("one-submodule", "behind-head", 700);

    // Action: catch up staging in every repository.
    const result = catchUpStaging(fixture.rootPath, fixture.taskNumber);

    // Verify: no conflict came back.
    assert.equal(result, null);
    for (const repo of fixture.repos) {
        // Verify: staging now sits at main.
        // assert.equal(git(repo.checkoutPath, "rev-parse", "staging"), git(repo.checkoutPath, "rev-parse", "main"), `${repo.occurrenceId}: staging tip`);
        // The root's main records a stale sub gitlink, so root staging gains one gitlink commit on top of main.
        const caughtUpRef = repo.occurrenceId === "root" ? "staging^" : "staging";
        assert.equal(git(repo.checkoutPath, "rev-parse", caughtUpRef), git(repo.checkoutPath, "rev-parse", "main"), `${repo.occurrenceId}: staging tip`);
        // Verify: git lists no merge worktree for this repository.
        assert.equal(git(repo.checkoutPath, "worktree", "list").includes("task-700-catchUpMerge"), false, `${repo.occurrenceId}: merge worktree`);
    }
});

test("test_catchUpStaging_removesTheMergeWorktreeAfterACleanDivergedMerge", () => {
    // Setup: a root with one submodule; in both repositories, staging holds a prior task's merge commit.
    const fixture = makeShapeFixture("one-submodule", "ahead-head", 701);
    // main gains one commit that adds diverge.txt in each repository, so staging and main diverge without a conflict.
    for (const repo of fixture.repos) {
        writeFileSync(join(repo.checkoutPath, "diverge.txt"), `${repo.occurrenceId}\n`);
        git(repo.checkoutPath, "add", "diverge.txt");
        git(repo.checkoutPath, "commit", "-q", "-m", "diverge head past staging");
    }

    // Action: catch up staging in every repository.
    const result = catchUpStaging(fixture.rootPath, fixture.taskNumber);

    // Verify: no conflict came back.
    assert.equal(result, null);
    for (const repo of fixture.repos) {
        // Verify: staging is a merge commit whose two parents are the prior staging tip and main.
        // const mergedTip = git(repo.checkoutPath, "rev-parse", "staging");
        // The sub's catch-up merge moves its staging, so root staging gains one gitlink commit on top of the merge.
        const mergedTip = git(repo.checkoutPath, "rev-parse", repo.occurrenceId === "root" ? "staging^" : "staging");
        const headTip = git(repo.checkoutPath, "rev-parse", "main");
        const parents = git(repo.checkoutPath, "log", "-1", "--pretty=%P", mergedTip).split(" ").sort();
        assert.deepEqual(parents, [repo.stagingTip!, headTip].sort(), `${repo.occurrenceId}: merge parents`);
        // Verify: git lists no merge worktree for this repository.
        assert.equal(git(repo.checkoutPath, "worktree", "list").includes("task-701-catchUpMerge"), false, `${repo.occurrenceId}: merge worktree`);
    }
});

test("test_catchUpStaging_leavesTheWorktreeAndReturnsOnlyTheRepositoryAndPathOnAConflict", () => {
    // Setup: a root with no submodule; staging sits at main.
    const fixture = makeShapeFixture("none", "at-head", 702);
    // staging changes the one line of seed.txt.
    git(fixture.rootPath, "checkout", "-q", "staging");
    writeFileSync(join(fixture.rootPath, "seed.txt"), "staging line\n");
    git(fixture.rootPath, "commit", "-q", "-am", "staging edits seed");
    // main changes the same line of seed.txt, so the merge conflicts.
    git(fixture.rootPath, "checkout", "-q", "main");
    writeFileSync(join(fixture.rootPath, "seed.txt"), "head line\n");
    git(fixture.rootPath, "commit", "-q", "-am", "head edits seed");

    // Action: catch up staging in every repository.
    const result = catchUpStaging(fixture.rootPath, fixture.taskNumber);

    // Verify: the result holds exactly the repository and its task-702-catchUpMerge path, with no file list.
    const expectedWorktreePath = join(resolveTaskWorktreeConventionDirectory(fixture.rootPath), "task-702-catchUpMerge");
    assert.deepEqual(result, { repository: fixture.rootPath, worktreePath: expectedWorktreePath });
    // Verify: git still reports seed.txt as unmerged in the returned worktree, so it was left in place.
    assert.equal(git(result!.worktreePath, "status", "--porcelain"), "UU seed.txt");
});

test("test_catchUpStaging_pointsTheRootStagingGitlinkAtTheSubmoduleStagingTip", () => {
    // Setup: a root with one submodule; staging sits at main in both repositories.
    const fixture = makeShapeFixture("one-submodule", "at-head", 703);
    const subPath = join(fixture.rootPath, "sub");
    const rootStagingBefore = git(fixture.rootPath, "rev-parse", "staging");
    // The submodule's staging gains a commit the root's gitlink does not record.
    git(subPath, "checkout", "-q", "staging");
    writeFileSync(join(subPath, "sub-staging.txt"), "ahead\n");
    git(subPath, "add", "sub-staging.txt");
    git(subPath, "commit", "-q", "-m", "sub staging ahead of root gitlink");
    git(subPath, "checkout", "-q", "main");
    const subStagingTip = git(subPath, "rev-parse", "staging");

    // Action: catch up staging in every repository.
    const result = catchUpStaging(fixture.rootPath, fixture.taskNumber);

    // Verify: no conflict came back.
    assert.equal(result, null);
    // Verify: root staging records the submodule's staging tip.
    assert.equal(git(fixture.rootPath, "rev-parse", "staging:sub"), subStagingTip);
    // Verify: the gitlink commit sits directly on the old root staging tip.
    assert.equal(git(fixture.rootPath, "rev-parse", "staging^"), rootStagingBefore);
});
