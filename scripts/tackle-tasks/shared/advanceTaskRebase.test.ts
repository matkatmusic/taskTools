// Behavioral checks for scripts/tackle-tasks/advanceTaskRebase.ts. Run: node --test tests/advanceTaskRebase.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceTaskRebase } from "./advanceTaskRebase.ts";
import { rebaseTaskWorktree } from "./rebaseTaskWorktree.ts";
import { acquireSourceRepoLock, buildLockOwner } from "./sourceRepoLock.ts";
import { claimTask, getCurrentTaskRun } from "./taskRunState.ts";
import { rebaseInProgress } from "../../mergeTaskWorktrees.ts";
import { createWorktreeForGroup } from "../../prepareTasks.ts";
import { resolveTaskFiles } from "../../taskFiles.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";

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

// F1: rootOriginChildPath is the real source child checkout - the local, possibly-unpushed authority the rebase now fetches from. It is distinct from the worktree's own child checkout.
function makeSourceRepoWithSubmodule(): { rootOrigin: string; childOrigin: string; rootOriginChildPath: string } {
    const childOrigin = makeTempRepoWithTestScript("child-main");
    const rootOrigin = makeTempRepoWithTestScript("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return { rootOrigin, childOrigin, rootOriginChildPath: join(rootOrigin, "child") };
}

let nextGroupId = 1;
// operationBranch is attached as "task-<taskNumber>" by the scripts under test, so taskNumber here must equal the worktree's real groupId - matching production's one-task-per-group.
function createLinkedWorktree(rootOrigin: string): { worktreePath: string; taskNumber: number } {
    const groupId = nextGroupId++;
    const worktreePath = createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
    return { worktreePath, taskNumber: groupId };
}

function seedTaskAndClaim(projectRoot: string, taskNumber: number, runId: string): void {
    const { tasksPath } = resolveTaskFiles(projectRoot);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title: "t", files: [] }]);
    const outcome = claimTask(taskNumber, runId, projectRoot);
    assert.equal(outcome.status, "claimed");
}

// Independently commits in the source's child checkout, never in the worktree's own child clone - simulating the source repository advancing while the task worktree exists.
function advanceSourceChildBranch(rootOrigin: string, rootOriginChildPath: string, content: string): void {
    writeFileSync(join(rootOriginChildPath, "shared.txt"), content);
    git(rootOriginChildPath, "add", "shared.txt");
    git(rootOriginChildPath, "commit", "-q", "-m", "advance source child");
    git(rootOrigin, "add", "child");
    git(rootOrigin, "commit", "-q", "-m", "bump child gitlink");
}

test("test_advanceTaskRebase_distinguishesTheRootAndASubmoduleWithTheSameConflictPath", async () => {
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-10");
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
    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");
    writeFileSync(join(rootOrigin, "shared.txt"), "root-source\n");
    git(rootOrigin, "add", "shared.txt");
    git(rootOrigin, "commit", "-q", "-m", "root source edit");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-10", stepId: "rebase-10", rootSourceBranch: "main" };
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
    const { rootOrigin, rootOriginChildPath } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-11");
    const childCheckoutPath = join(worktreePath, "child");

    writeFileSync(join(childCheckoutPath, "shared.txt"), "child-worktree\n");
    git(childCheckoutPath, "add", "shared.txt");
    git(childCheckoutPath, "commit", "-q", "-m", "child worktree edit");
    git(worktreePath, "add", "child");
    git(worktreePath, "commit", "-q", "-m", "bump child gitlink");

    advanceSourceChildBranch(rootOrigin, rootOriginChildPath, "child-source\n");

    const rebaseInput = { projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-11", stepId: "rebase-11", rootSourceBranch: "main" };
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

    // F3: the finished rebase persisted its source-tip receipt.
    const run = getCurrentTaskRun(taskNumber, rootOrigin) as { sourceTipsAtRebase?: { occurrenceId: string; baseBranch: string; sourceTip: string }[] } | null;
    assert.deepEqual(run?.sourceTipsAtRebase?.map((receipt) => receipt.occurrenceId).sort(), ["", "child"]);
});

test("test_advanceTaskRebase_refusesAndMutatesNothingWhenTheLockIsHeldByAnotherRun", () => {
    const { rootOrigin } = makeSourceRepoWithSubmodule();
    const { worktreePath, taskNumber } = createLinkedWorktree(rootOrigin);
    seedTaskAndClaim(rootOrigin, taskNumber, "run-20");
    acquireSourceRepoLock(rootOrigin, buildLockOwner("other-run", taskNumber));
    const beforeHead = git(worktreePath, "rev-parse", "HEAD");

    assert.throws(() => advanceTaskRebase({
        projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-20", stepId: "rebase-20", rootSourceBranch: "main",
        stoppedAt: { occurrenceId: "", checkoutPath: worktreePath },
    }));

    assert.equal(git(worktreePath, "rev-parse", "HEAD"), beforeHead);
    assert.equal(rebaseInProgress(worktreePath), false);
    const run = getCurrentTaskRun(taskNumber, rootOrigin) as { sourceTipsAtRebase?: unknown } | null;
    assert.equal(run?.sourceTipsAtRebase, undefined);
});

