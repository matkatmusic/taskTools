// Behavioral checks for scripts/tackle-tasks/advanceTaskRebase.ts. Run: node --test tests/tackle-tasks/advanceTaskRebase.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceTaskRebase } from "../../scripts/tackle-tasks/advanceTaskRebase.ts";
import { rebaseTaskWorktree } from "../../scripts/tackle-tasks/rebaseTaskWorktree.ts";
import { rebaseInProgress } from "../../scripts/mergeTaskWorktrees.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

function makeTempRepoWithTestScript(branchName: string): string {
    const repoPath = tmpMkdir("advance-rebase-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(repoPath, "add", "package.json");
    git(repoPath, "commit", "-q", "-m", "seed");
    writeFileSync(join(repoPath, "shared.txt"), "base\n");
    git(repoPath, "add", "shared.txt");
    git(repoPath, "commit", "-q", "-m", "add shared.txt");
    return repoPath;
}

function makeSourceRepoWithSubmodule(): { rootOrigin: string; childOrigin: string } {
    const childOrigin = makeTempRepoWithTestScript("child-main");
    const rootOrigin = makeTempRepoWithTestScript("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return { rootOrigin, childOrigin };
}

let nextGroupId = 1;
// operationBranch is attached as "task-<taskNumber>" by the scripts under test, so taskNumber
// here must equal the worktree's real groupId - matching production's one-task-per-group.
function createLinkedWorktree(rootOrigin: string): { worktreePath: string; taskBranch: string; taskNumber: number } {
    const groupId = nextGroupId++;
    const taskBranch = `task-${groupId}`;
    const worktreePath = createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
    return { worktreePath, taskBranch, taskNumber: groupId };
}

// rebaseSubmoduleLayersDeepestFirst fetches "from source" using the manifest's own checkoutPath,
// which buildDiscoveryManifest deliberately remaps into the worktree (occurrences.ts) - so the
// submodule's own local base-branch ref, inside its worktree clone, is the thing that must move
// to simulate the source repository having advanced. Moving the true upstream origin is invisible.
function advanceChildBaseBranch(childCheckoutPath: string, baseBranch: string, taskBranch: string, content: string): void {
    git(childCheckoutPath, "checkout", "-q", baseBranch);
    writeFileSync(join(childCheckoutPath, "shared.txt"), content);
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", `advance ${baseBranch}`);
    git(childCheckoutPath, "checkout", "-q", taskBranch);
}

test("test_advanceTaskRebase_distinguishesTheRootAndASubmoduleWithTheSameConflictPath", async () => {
    const { rootOrigin } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskBranch, taskNumber } = createLinkedWorktree(rootOrigin);
    const childCheckoutPath = join(worktreePath, "child");

    // Worktree edits both layers' shared.txt.
    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");
    writeFileSync(join(worktreePath, "shared.txt"), "root-worktree\n");
    git(worktreePath, "add", "shared.txt");
    git(worktreePath, "commit", "-q", "-m", "root worktree edit");

    // Source moves both layers' shared.txt too, guaranteeing a conflict in each.
    advanceChildBaseBranch(childCheckoutPath, "child-main", taskBranch, "child-source\n");
    writeFileSync(join(rootOrigin, "shared.txt"), "root-source\n");
    git(rootOrigin, "add", "shared.txt");
    git(rootOrigin, "commit", "-q", "-m", "root source edit");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-10", rootSourceBranch: "main" };
    const first = await rebaseTaskWorktree(rebaseInput);
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");
    assert.deepEqual(first.conflictedFilePaths, ["shared.txt"]);

    // Resolve the submodule conflict and stage it, without running --continue ourselves.
    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved\n");
    git(childCheckoutPath, "add", "shared.txt");

    const second = advanceTaskRebase({ ...rebaseInput, stoppedAt: first.stoppedAt! });
    assert.equal(second.finished, false);
    assert.equal(second.conflicted, true);
    assert.equal(second.stoppedAt?.occurrenceId, "");
    assert.notEqual(second.stoppedAt?.occurrenceId, first.stoppedAt?.occurrenceId);
    assert.deepEqual(second.conflictedFilePaths, ["shared.txt"]);
});

test("test_advanceTaskRebase_reportsFinishedOnlyWhenNoLayerHasARebaseInProgress", async () => {
    const { rootOrigin } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskBranch, taskNumber } = createLinkedWorktree(rootOrigin);
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    advanceChildBaseBranch(childCheckoutPath, "child-main", taskBranch, "child-source\n");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-11", rootSourceBranch: "main" };
    const first = await rebaseTaskWorktree(rebaseInput);
    assert.equal(first.conflicted, true);
    assert.equal(first.stoppedAt?.occurrenceId, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "resolved\n");
    git(childCheckoutPath, "add", "shared.txt");

    const second = advanceTaskRebase({ ...rebaseInput, stoppedAt: first.stoppedAt! });

    assert.equal(second.finished, true);
    assert.equal(second.conflicted, false);
    assert.equal(second.stoppedAt, null);
    assert.equal(rebaseInProgress(childCheckoutPath), false);
    assert.equal(rebaseInProgress(worktreePath), false);
});
