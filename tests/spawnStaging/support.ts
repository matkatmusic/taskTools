// Shared setup and assertions for the spawnStaging test matrix; wraps createTaskWorktree and its four per-repo invariants.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { git } from "../support/gitFixtures.ts";
import type { RepoNode, ShapeFixture, StagingState } from "../support/repoShapeFixtures.ts";
import { createTaskWorktree } from "../../scripts/tackle-tasks/shared/createTaskWorktree.ts";
import { claimTask } from "../../scripts/tackle-tasks/shared/taskRunState.ts";

// Seeds tasks.json with one task record and claims it, exactly as createTaskWorktree.test.ts does.
function seedTaskAndClaim(root: string, taskNumber: number, runId: string): void {
    writeFileSync(
        join(root, "tasks.json"),
        `${JSON.stringify([{ taskNumber, title: `t${taskNumber}`, description: "spawn staging test", modifiableFiles: [] }], null, 2)}\n`,
    );
    claimTask(taskNumber, runId, root);
}

// Seeds the task, then calls the spawn entry point under test. Returns the new worktree path.
export function spawnWorktree(fixture: ShapeFixture, runId: string): string {
    seedTaskAndClaim(fixture.rootPath, fixture.taskNumber, runId);
    return createTaskWorktree(fixture.taskNumber, runId, fixture.rootPath).worktree;
}

// The root repo maps to the worktree root itself; a submodule maps to its path inside the worktree.
function repoRelativePath(fixture: ShapeFixture, repo: RepoNode): string {
    return relative(fixture.rootPath, repo.checkoutPath);
}

// absent/at-head/behind-head all settle staging at HEAD; ahead-head leaves the prior merge tip untouched.
export function expectedStagingTip(repo: RepoNode, state: StagingState): string {
    return state === "ahead-head" ? repo.stagingTip! : repo.headTip;
}

// One repo's four spawn invariants: source task-N ref, source reset-point ref, worktree branch, worktree HEAD.
export function assertRepoSpawned(fixture: ShapeFixture, repo: RepoNode, worktree: string, expectedTip: string): void {
    const branch = `task-${fixture.taskNumber}`;
    const relPath = repoRelativePath(fixture, repo);
    const label = relPath === "" ? "root" : relPath;
    const worktreeRepoPath = relPath === "" ? worktree : join(worktree, relPath);

    assert.equal(git(repo.checkoutPath, "rev-parse", branch), expectedTip, `${label}: source ${branch} tip`);
    assert.equal(
        git(repo.checkoutPath, "rev-parse", `refs/taskTools/reset-point/${branch}`),
        expectedTip,
        `${label}: reset-point tip`,
    );
    assert.equal(git(worktreeRepoPath, "branch", "--show-current"), branch, `${label}: worktree branch`);
    assert.equal(git(worktreeRepoPath, "rev-parse", "HEAD"), expectedTip, `${label}: worktree HEAD`);
}

// Runs assertRepoSpawned for every repo in the fixture (root and every submodule, at every depth).
export function assertAllRepoSpawned(fixture: ShapeFixture, state: StagingState, worktree: string): void {
    for (const repo of fixture.repos) {
        assertRepoSpawned(fixture, repo, worktree, expectedStagingTip(repo, state));
    }
}
