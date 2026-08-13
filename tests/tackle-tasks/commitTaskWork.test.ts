// Behavioral checks for scripts/tackle-tasks/commitTaskWork.ts. Run: node --test tests/tackle-tasks/commitTaskWork.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitTaskWork } from "../../scripts/tackle-tasks/commitTaskWork.ts";
import { reconcileStep } from "../../scripts/tackle-tasks/reconcileStep.ts";
import { claimTask, getCurrentTaskRun } from "../../scripts/tackle-tasks/taskRunState.ts";
import { createWorktreeForGroup } from "../../scripts/prepareTasks.ts";
import { resolveTaskFiles } from "../../scripts/taskFiles.ts";
import { writeJsonAtomically } from "../../scripts/taskStateLock.ts";

process.env.GIT_ALLOW_PROTOCOL = "file";

function git(repoPath: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
}

function makeTempRepoWithCommit(branchName: string): string {
    const repoPath = tmpMkdir("commit-task-work-");
    git(repoPath, "init", "-q", "-b", branchName);
    git(repoPath, "config", "user.email", "test@example.com");
    git(repoPath, "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    git(repoPath, "add", "seed.txt");
    git(repoPath, "commit", "-q", "-m", "seed");
    return repoPath;
}

function tmpMkdir(prefix: string): string {
    return execFileSync("mktemp", ["-d", join(tmpdir(), `${prefix}XXXXXX`)], { encoding: "utf8" }).trim();
}

// The canonical source repository: a root repo with one real submodule, per global rule 9.
function makeSourceRepoWithSubmodule(): string {
    const childOrigin = makeTempRepoWithCommit("child-main");
    const rootOrigin = makeTempRepoWithCommit("main");
    git(rootOrigin, "submodule", "add", "-q", childOrigin, "child");
    git(rootOrigin, "commit", "-q", "-m", "add submodule child");
    return rootOrigin;
}

let nextGroupId = 1;
function createLinkedWorktree(rootOrigin: string): string {
    const groupId = nextGroupId++;
    return createWorktreeForGroup(rootOrigin, { groupId, taskNumbers: [groupId], filePaths: [], scope: "declared" });
}

function seedTaskAndClaim(rootOrigin: string, taskNumber: number, title: string, runId: string): void {
    const { tasksPath } = resolveTaskFiles(rootOrigin);
    mkdirSync(join(tasksPath, ".."), { recursive: true });
    writeJsonAtomically(tasksPath, [{ taskNumber, title, files: [] }]);
    const outcome = claimTask(taskNumber, runId, rootOrigin);
    assert.equal(outcome.status, "claimed");
}

test("test_commitTaskWork_commitsDeepestFirstAndBumpsTheParentGitlink", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9001;
    seedTaskAndClaim(rootOrigin, taskNumber, "add a widget", "run-1");

    writeFileSync(join(worktreePath, "child", "widget.txt"), "widget\n");
    writeFileSync(join(worktreePath, "root-widget.txt"), "root widget\n");

    const result = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "step-1", rootSourceBranch: "main" });

    assert.equal(result.commits.length, 2);
    assert.equal(result.commits[0].occurrenceId, "child");
    assert.equal(result.commits[1].occurrenceId, "");
    // The parent's commit must include the bumped child gitlink.
    const parentDiffStat = git(worktreePath, "show", "--stat", result.commits[1].hash);
    assert.match(parentDiffStat, /child/);
    assert.match(parentDiffStat, /root-widget\.txt/);
});

test("test_commitTaskWork_returnsNoCommitsWhenEveryLayerIsClean", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9002;
    seedTaskAndClaim(rootOrigin, taskNumber, "no-op task", "run-1");

    const result = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "step-1", rootSourceBranch: "main" });

    assert.deepEqual(result.commits, []);
});

test("test_commitTaskWork_usesTheWorkKindForTheFirstCommitAndRepairForEveryLater", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9003;
    seedTaskAndClaim(rootOrigin, taskNumber, "fix the thing", "run-1");

    writeFileSync(join(worktreePath, "first.txt"), "first\n");
    const first = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "step-1", rootSourceBranch: "main" });
    assert.equal(first.commits.length, 1);
    assert.equal(first.commits[0].kind, "work");
    assert.match(git(worktreePath, "log", "-1", "--format=%s"), /fix the thing/);

    writeFileSync(join(worktreePath, "second.txt"), "second\n");
    const second = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "step-2", rootSourceBranch: "main" });
    assert.equal(second.commits.length, 1);
    assert.equal(second.commits[0].kind, "repair");
    assert.match(git(worktreePath, "log", "-1", "--format=%s"), /fixed code making tests fail/);

    const run = getCurrentTaskRun(taskNumber, rootOrigin);
    assert.equal(run?.commits.length, 2);
    assert.deepEqual(run?.commits.map((commit) => commit.kind), ["work", "repair"]);
});

// F2: simulates a process dying between `git commit` and `appendTaskCommits` by making exactly
// the commit commitTaskWork would make (same message, same "Task-Step" trailer) directly, then
// leaving the run record untouched. Before the fix, commitTaskWork skipped any clean layer
// unconditionally, so this rerun would see a clean root, commit nothing, and return
// `commits: []` — the hash would stay unrecorded forever. It must fail this way pre-fix because
// there was no code path that read a layer's HEAD to recognize a commit as "already made by this
// step".
test("test_commitTaskWork_recoversAnUnrecordedCommitAfterAKillBetweenGitCommitAndAppendTaskCommits", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9004;
    const stepId = "step-1";
    seedTaskAndClaim(rootOrigin, taskNumber, "recover it", "run-1");

    writeFileSync(join(worktreePath, "root-only.txt"), "root only\n");
    git(worktreePath, "add", "-A");
    git(worktreePath, "commit", "-q", "-m", `task ${taskNumber}: recover it\n\nTask-Step: ${stepId}`);
    const landedHash = git(worktreePath, "rev-parse", "HEAD");
    assert.equal(getCurrentTaskRun(taskNumber, rootOrigin)?.commits.length, 0);

    const result = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId, rootSourceBranch: "main" });

    // No second commit was made; HEAD is exactly the one that already landed.
    assert.equal(git(worktreePath, "rev-parse", "HEAD"), landedHash);
    assert.deepEqual(result.commits, [{ occurrenceId: "", hash: landedHash, kind: "work", stepId }]);
    const run = getCurrentTaskRun(taskNumber, rootOrigin);
    assert.equal(run?.commits.length, 1);
    assert.equal(run?.commits[0].hash, landedHash);

    const reconciled = reconcileStep({
        script: "commitTaskWork", stepId, taskNumber, runId: "run-1", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(reconciled.status, "completed");
    assert.deepEqual(reconciled.result?.commits, [{ occurrenceId: "", hash: landedHash, kind: "work", stepId }]);
});

// F2: two logical commit visits in one run. Step "step-A" really commits and is recorded; step
// "step-B" is a later, distinct logical step whose own result is lost before it ever committed
// anything. Before the fix, reconcileCommitTaskWork looked at every non-merge commit on the
// record without checking which step made it, saw step A's commit still sitting unstranded at
// HEAD, and reported "completed" for step B too - even though step B never ran.
test("test_commitTaskWork_reconciliationRejectsAnOlderStepsReceiptForANewerStep", () => {
    const rootOrigin = makeSourceRepoWithSubmodule();
    const worktreePath = createLinkedWorktree(rootOrigin);
    const taskNumber = 9005;
    seedTaskAndClaim(rootOrigin, taskNumber, "two visits", "run-1");

    writeFileSync(join(worktreePath, "first.txt"), "first\n");
    const first = commitTaskWork({ projectRoot: rootOrigin, worktreePath, taskNumber, runId: "run-1", stepId: "step-A", rootSourceBranch: "main" });
    assert.equal(first.commits.length, 1);

    // step-B is a no-op visit: nothing dirty, nothing it needed to commit, and no record entry
    // of its own — but it must not be reported as complete by borrowing step-A's evidence.
    const staleVisit = reconcileStep({
        script: "commitTaskWork", stepId: "step-B", taskNumber, runId: "run-1", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(staleVisit.status, "not-completed");

    // Sanity: the step that actually committed is still recognized.
    const matchingVisit = reconcileStep({
        script: "commitTaskWork", stepId: "step-A", taskNumber, runId: "run-1", projectRoot: rootOrigin,
        stepInput: { worktreePath, rootSourceBranch: "main" },
    });
    assert.equal(matchingVisit.status, "completed");
});
