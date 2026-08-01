// Behavioral checks for mergeTaskWorktrees.ts: merges, conflict abort, gitlink resolution, submodule merges. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktreeForGroup } from "../scripts/prepareTasks.ts";
import type { PreparedGroup, WorkflowArguments } from "../scripts/prepareTasks.ts";
import { currentBranchName } from "../scripts/repositoryBranches.ts";
import {
    mergeGroupBranchIntoRepo,
    mergeSubmoduleBranchIntoRepo,
    removeWorktreeAndBranch,
    resolveGitlinkConflicts,
} from "../scripts/mergeTaskWorktrees.ts";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "mergeTaskWorktrees.ts");

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "merge-worktrees-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function makeGroup(repoRoot: string, groupId: number): PreparedGroup {
    const worktree = createWorktreeForGroup(repoRoot, { groupId, taskNumbers: [groupId], filePaths: [], scope: "unknown" });
    return { groupId, worktree, branch: `task-group-${groupId}`, scope: "unknown", tasks: [] };
}

function makeTempRepoWithLocalSubmodule(): string {
    const submoduleOrigin = makeTempRepoWithCommit();
    // git >=2.38 blocks file-transport submodules; repo config is ignored here, env is not.
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const repoRoot = makeTempRepoWithCommit();
    git(repoRoot, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(repoRoot, "commit", "-q", "-m", "add submodule");
    return repoRoot;
}

test("test_removeWorktreeAndBranchDeletesAWorktreeThatContainsSubmodules", () => {
    // Setup: a worktree whose submodule was populated by createWorktreeForGroup.
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const group = makeGroup(repoRoot, 1);
    assert.equal(existsSync(join(group.worktree, "vendor", "seed.txt")), true);
    // Test action and verification: cleanup removes the worktree instead of refusing.
    removeWorktreeAndBranch(repoRoot, group.worktree, group.branch);
    assert.equal(existsSync(group.worktree), false);
});

test("test_mergeGroupBranchIntoRepoReportsSuccessForANonConflictingBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, true);
    assert.deepEqual(outcome.conflictedFilePaths, []);
    assert.equal(existsSync(join(repoRoot, "new.txt")), true);
});

test("test_mergeGroupBranchIntoRepoReportsConflictedPathsAndAbortsTheMerge", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, false);
    assert.deepEqual(outcome.conflictedFilePaths, ["shared.txt"]);
    const status = git(repoRoot, "status", "--porcelain=v1", "-z").trim();
    assert.equal(status.includes("MERGE_MSG"), false);
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
});

test("test_mergeGroupBranchIntoRepoLeavesTheWorktreeInPlaceAfterAConflict", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(existsSync(group.worktree), true);
});

test("test_removeWorktreeAndBranchDeletesBothAfterACleanMerge", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");
    git(repoRoot, "merge", "--no-ff", group.branch, "-q", "-m", "merge");

    removeWorktreeAndBranch(repoRoot, group.worktree, group.branch);
    assert.equal(existsSync(group.worktree), false);
    const branches = git(repoRoot, "branch", "--list");
    assert.equal(branches.includes(group.branch), false);
});

test("test_mergeGroupBranchIntoRepoContinuesToLaterGroupsAfterAnEarlierConflict", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group1 = makeGroup(repoRoot, 1);
    writeFileSync(join(group1.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group1.worktree, "add", "shared.txt");
    git(group1.worktree, "commit", "-q", "-m", "worktree edit");
    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    const group2 = makeGroup(repoRoot, 2);
    writeFileSync(join(group2.worktree, "group2.txt"), "clean add\n");
    git(group2.worktree, "add", "group2.txt");
    git(group2.worktree, "commit", "-q", "-m", "add group2.txt");

    const outcome1 = mergeGroupBranchIntoRepo(repoRoot, group1, sourceBranch, []);
    const outcome2 = mergeGroupBranchIntoRepo(repoRoot, group2, sourceBranch, []);
    assert.equal(outcome1.merged, false);
    assert.equal(outcome2.merged, true);
});

test("test_mergeGroupBranchIntoRepoChecksOutTheSourceBranchBeforeMerging", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    git(repoRoot, "checkout", "-b", "some-other-branch");

    const outcome = mergeGroupBranchIntoRepo(repoRoot, group, sourceBranch, []);
    assert.equal(outcome.merged, true);
    assert.equal(currentBranchName(repoRoot), sourceBranch);
    assert.equal(existsSync(join(repoRoot, "new.txt")), true);
});

test("test_mergeSubmoduleBranchSurvivesEvenWhenTheGroupConflicts", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const sourceBranch = currentBranchName(mainSubmodulePath);
    const group = makeGroup(repoRoot, 1);
    const worktreeSubmodulePath = join(group.worktree, "vendor");
    const groupBranch = currentBranchName(worktreeSubmodulePath);

    writeFileSync(join(worktreeSubmodulePath, "seed.txt"), "from-worktree\n");
    git(worktreeSubmodulePath, "add", "seed.txt");
    git(worktreeSubmodulePath, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(mainSubmodulePath, "seed.txt"), "from-main\n");
    git(mainSubmodulePath, "add", "seed.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "main edit");

    const outcome = mergeSubmoduleBranchIntoRepo(mainSubmodulePath, worktreeSubmodulePath, sourceBranch);
    assert.equal(outcome.merged, false);
    const branches = git(mainSubmodulePath, "branch", "--list", groupBranch);
    assert.ok(branches.includes(groupBranch));
});

test("test_runAsCliLeavesTheWorktreeAndBranchInPlaceAfterASuccessfulMerge", () => {
    const repoRoot = makeTempRepoWithCommit();
    const sourceBranch = currentBranchName(repoRoot);
    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "new.txt"), "brand new\n");
    git(group.worktree, "add", "new.txt");
    git(group.worktree, "commit", "-q", "-m", "add new.txt");

    const preparedGroup: PreparedGroup = group;
    const workflowArguments: WorkflowArguments = {
        repo: repoRoot,
        typecheckCommand: "npx tsc --noEmit",
        groups: [preparedGroup],
        repositorySources: [{ path: "", sourceBranch }],
    };
    execFileSync("node", ["--no-inspect", SCRIPT, JSON.stringify(workflowArguments)], { encoding: "utf8" });

    assert.equal(existsSync(group.worktree), true);
    const branches = git(repoRoot, "branch", "--list", group.branch);
    assert.ok(branches.includes(group.branch));
});

test("test_resolveGitlinkConflictsAutoResolvesASubmodulePointerConflict", () => {
    const repoRoot = makeTempRepoWithLocalSubmodule();
    const mainSubmodulePath = join(repoRoot, "vendor");
    const baseBranch = currentBranchName(repoRoot);
    const submoduleBaseBranch = currentBranchName(mainSubmodulePath);

    git(mainSubmodulePath, "checkout", "-b", "branch-a");
    writeFileSync(join(mainSubmodulePath, "a.txt"), "a\n");
    git(mainSubmodulePath, "add", "a.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "a");
    const commitA = git(mainSubmodulePath, "rev-parse", "HEAD").trim();

    git(mainSubmodulePath, "checkout", submoduleBaseBranch);
    git(mainSubmodulePath, "checkout", "-b", "branch-b");
    writeFileSync(join(mainSubmodulePath, "b.txt"), "b\n");
    git(mainSubmodulePath, "add", "b.txt");
    git(mainSubmodulePath, "commit", "-q", "-m", "b");
    const commitB = git(mainSubmodulePath, "rev-parse", "HEAD").trim();

    git(mainSubmodulePath, "checkout", commitA);
    git(repoRoot, "checkout", "-b", "feature");
    git(repoRoot, "add", "vendor");
    git(repoRoot, "commit", "-q", "-m", "feature submodule pointer");

    git(repoRoot, "checkout", baseBranch);
    git(mainSubmodulePath, "checkout", commitB);
    git(repoRoot, "add", "vendor");
    git(repoRoot, "commit", "-q", "-m", "base submodule pointer");

    let threw = false;
    try {
        git(repoRoot, "merge", "--no-ff", "feature", "-m", "merge feature");
    } catch {
        threw = true;
    }
    assert.equal(threw, true);

    // Intended resolution: keep feature's submodule commit.
    git(mainSubmodulePath, "checkout", commitA);

    const resolution = resolveGitlinkConflicts(repoRoot, ["vendor"]);
    assert.equal(resolution.resolved, true);
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
});

test("test_resolveGitlinkConflictsAbortsOnANonSubmoduleConflict", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "shared.txt"), "line1\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "add shared.txt");

    const group = makeGroup(repoRoot, 1);
    writeFileSync(join(group.worktree, "shared.txt"), "line1-from-worktree\n");
    git(group.worktree, "add", "shared.txt");
    git(group.worktree, "commit", "-q", "-m", "worktree edit");

    writeFileSync(join(repoRoot, "shared.txt"), "line1-from-main\n");
    git(repoRoot, "add", "shared.txt");
    git(repoRoot, "commit", "-q", "-m", "main edit");

    let threw = false;
    try {
        git(repoRoot, "merge", "--no-ff", group.branch, "-m", "merge");
    } catch {
        threw = true;
    }
    assert.equal(threw, true);

    const resolution = resolveGitlinkConflicts(repoRoot, []);
    assert.equal(resolution.resolved, false);
    assert.ok(resolution.unexpectedConflicts.includes("shared.txt"));
    assert.equal(existsSync(join(repoRoot, ".git", "MERGE_HEAD")), false);
});
