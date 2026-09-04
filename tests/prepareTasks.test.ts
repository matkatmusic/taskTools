// Behavioral checks for prepareTasks.ts: brief writing, worktree creation, workflow args.  Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
    acquireTaskWorktreeLease,
    buildWorkflowArguments,
    createWorktreeForGroup,
    currentWorkflowOutputPath,
    generateRunId,
    materializeTaskWorkflow,
    modifiableFiles,
    readOnlyFiles,
    recoverStaleTaskWorktreeLease,
    releaseTaskWorktreeLease,
    resolveMergeScriptPath,
    resolveTaskWorktreeConventionDirectory,
    selectRequestedTasks,
    taskWorktreeLeaseGuardPath,
    v1_1WorkflowOutputPath,
    withTaskWorktreeLeaseGuard,
    writeTaskBriefFile,
} from "../scripts/prepareTasks.ts";
import { loadPreparedTask } from "../scripts/tackle-tasks/shared/preparedTask.ts";
import { skillBody as v1_1SkillBody } from "../scripts/tackle-tasks-v1_1_SkillBodyEmitter.ts";
import type { TaskGroup } from "../scripts/taskGroups.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";

function git(repoRoot: string, ...args: string[]): string {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
}

function makeTempRepoWithCommit(): string {
    const repoRoot = mkdtempSync(join(tmpdir(), "prepare-tasks-"));
    git(repoRoot, "init", "-q");
    git(repoRoot, "config", "user.email", "test@example.com");
    git(repoRoot, "config", "user.name", "Test");
    writeFileSync(join(repoRoot, "seed.txt"), "seed\n");
    git(repoRoot, "add", "seed.txt");
    git(repoRoot, "commit", "-q", "-m", "seed");
    return repoRoot;
}

function makeTempRepoWithLocalSubmodule(): { repoRoot: string; submoduleOrigin: string } {
    const submoduleOrigin = makeTempRepoWithCommit();
    writeFileSync(join(submoduleOrigin, "inner.txt"), "SUBMODULE-MARKER\n");
    git(submoduleOrigin, "add", "inner.txt");
    git(submoduleOrigin, "commit", "-q", "-m", "inner");
    const repoRoot = makeTempRepoWithCommit();
    // git >=2.38 blocks file-transport submodules; repo config is ignored here, env is not.
    process.env.GIT_ALLOW_PROTOCOL = "file";
    git(repoRoot, "submodule", "add", "-q", submoduleOrigin, "vendor");
    git(repoRoot, "commit", "-q", "-m", "add submodule");
    return { repoRoot, submoduleOrigin };
}

test("test_writeTaskBriefFileEmbedsTheDeclaredFilePointers", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "fileA.txt"), "MARKER-abc123\n");
    const task = { taskNumber: 1, title: "t1", description: "do the thing", files: ["fileA.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    assert.equal(briefFile, join(repoRoot, "plans", "brief-1.md"));
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /do the thing/);
    assert.match(text, /@fileA\.txt/);
    assert.doesNotMatch(text, /MARKER-abc123/); // make sure the file content is not embedded, only the pointer
});

test("test_writeTaskBriefFileAnnotatesMissingFilesWithoutThrowing", () => {
    const repoRoot = makeTempRepoWithCommit();
    const task = { taskNumber: 2, title: "t2", description: "desc", files: ["missing.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /missing\.txt/);
    assert.match(text, /\(missing: file not found on disk\)/);
});

test("test_writeTaskBriefFileJoinsTheGoalArrayIntoOneMarkdownBlock", () => {
    // goal is stored one line per entry; the brief must rejoin them, not comma-join them.
    const repoRoot = makeTempRepoWithCommit();
    const chainGoal = ["Tasks 1-2 ship it", "end to end"];
    const goal = ["- the gate passes", "- renaming is task 2, not this task"];
    const briefFile = writeTaskBriefFile({ taskNumber: 3, title: "t3", chainGoal, goal, description: "desc", files: [] }, repoRoot);
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /## Chain goal\n\nTasks 1-2 ship it\nend to end/);
    assert.match(text, /## Goal\n\n\*\*This task is considered done when all of these are true:\*\*\n\n- the gate passes\n- renaming is task 2, not this task/);
    assert.doesNotMatch(text, /ship it,/); // a comma means the array was stringified instead of joined
});

test("test_writeTaskBriefFileOmitsTheGoalHeadingWhenNoGoalIsDeclared", () => {
    // Tasks written before the goal field must produce the same brief they always did.
    const repoRoot = makeTempRepoWithCommit();
    const briefFile = writeTaskBriefFile({ taskNumber: 4, title: "t4", description: "desc", files: [] }, repoRoot);
    assert.doesNotMatch(readFileSync(briefFile, "utf8"), /## Goal/);
});

test("test_createWorktreeForGroupCreatesACheckoutOnItsOwnBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    assert.equal(existsSync(worktreePath), true);
    const branch = git(worktreePath, "branch", "--show-current").trim();
    assert.equal(branch, "task-1");
});

test("test_createWorktreeForGroupCutsTheWorktreeFromStaging", () => {
    // repo has an original branch and a staging branch one commit ahead
    const repoRoot = makeTempRepoWithCommit();
    const originalBranch = git(repoRoot, "branch", "--show-current").trim();
    git(repoRoot, "checkout", "-q", "-b", "staging");
    writeFileSync(join(repoRoot, "staging-only.txt"), "staging work\n");
    git(repoRoot, "add", "staging-only.txt");
    git(repoRoot, "commit", "-q", "-m", "staging work");
    const stagingTip = git(repoRoot, "rev-parse", "staging").trim();
    git(repoRoot, "checkout", "-q", originalBranch);

    // cut a new worktree for a group
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);

    // the new worktree's HEAD is staging's tip, not the original branch's
    assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), stagingTip);
});

test("test_createWorktreeForGroupCreatesStagingFromHeadWhenItIsMissing", () => {
    // repo has no staging branch yet
    const repoRoot = makeTempRepoWithCommit();
    const headTip = git(repoRoot, "rev-parse", "HEAD").trim();

    // cut a new worktree for a group
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    createWorktreeForGroup(repoRoot, group);

    // staging now exists, created from HEAD
    assert.equal(git(repoRoot, "rev-parse", "staging").trim(), headTip);
});

test("test_createWorktreeForGroupMovesAMergedStagingToHead", () => {
    // Setup: staging sits at B; the current branch has moved on to O, so staging is fully merged.
    const repoRoot = makeTempRepoWithCommit();
    git(repoRoot, "branch", "staging");
    const oldStagingTip = git(repoRoot, "rev-parse", "staging").trim();
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    const headTip = git(repoRoot, "rev-parse", "HEAD").trim();
    assert.notEqual(oldStagingTip, headTip);
    // Test action: cut a worktree.
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    // Verification: staging moved to HEAD, and the worktree sits there too.
    assert.equal(git(repoRoot, "rev-parse", "refs/heads/staging").trim(), headTip);
    assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), headTip);
});

test("test_createWorktreeForGroupFastForwardsAMergedStagingThatIsCheckedOutElsewhere", () => {
    // Setup: staging is merged into HEAD but another worktree has it checked out, so git branch -f refuses.
    const repoRoot = makeTempRepoWithCommit();
    git(repoRoot, "branch", "staging");
    const stagingWorktree = mkdtempSync(join(tmpdir(), "staging-checkout-"));
    git(repoRoot, "worktree", "add", "-q", stagingWorktree, "staging");
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    const headTip = git(repoRoot, "rev-parse", "HEAD").trim();
    // Test action and verification: staging moves to HEAD inside that checkout.
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    createWorktreeForGroup(repoRoot, group);
    assert.equal(git(repoRoot, "rev-parse", "refs/heads/staging").trim(), headTip);
    assert.equal(git(stagingWorktree, "rev-parse", "HEAD").trim(), headTip);
});

test("test_createWorktreeForGroupReusesAnExistingWorktreeAtTheSamePath", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const first = createWorktreeForGroup(repoRoot, group, "run-1");
    // A previous run's lease is released only on its own successful final cleanup; simulate that here.
    releaseTaskWorktreeLease({ worktreePath: first, runId: "run-1" });
    const second = createWorktreeForGroup(repoRoot, group, "run-2");
    assert.equal(second, first);
});

test("test_createWorktreeForGroupCreatesMissingStagingBeforeReusingAWorktree", () => {
    // Setup: a first run cut the worktree folder and released its lease.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const firstWorktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    releaseTaskWorktreeLease({ worktreePath: firstWorktreePath, runId: "run-1" });
    // Setup: the staging branch is gone; the root checkout still sits on its original branch.
    git(repoRoot, "branch", "-D", "staging");
    const headTip = git(repoRoot, "rev-parse", "HEAD").trim();
    // Test action: a second run reuses the folder.
    const secondWorktreePath = createWorktreeForGroup(repoRoot, group, "run-2");
    // Verification: staging exists again at HEAD, and the reused folder sits at that exact commit.
    assert.equal(git(repoRoot, "rev-parse", "refs/heads/staging").trim(), headTip);
    assert.equal(git(secondWorktreePath, "rev-parse", "HEAD").trim(), headTip);
});

test("test_createWorktreeForGroupDoesNotCallTheStagingTipRetainedWhenTheLauncherDiverged", () => {
    // Setup: staging holds commit S; the original branch holds a different commit O.
    const repoRoot = makeTempRepoWithCommit();
    const originalBranch = git(repoRoot, "branch", "--show-current").trim();
    git(repoRoot, "checkout", "-q", "-b", "staging");
    writeFileSync(join(repoRoot, "staging-only.txt"), "staging work\n");
    git(repoRoot, "add", "staging-only.txt");
    git(repoRoot, "commit", "-q", "-m", "S");
    git(repoRoot, "checkout", "-q", originalBranch);
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    // Setup: a first run cut the folder at S and released its lease.
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const firstWorktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    releaseTaskWorktreeLease({ worktreePath: firstWorktreePath, runId: "run-1" });
    // Test action and verification: a clean folder at the staging tip is not retained work.
    assert.doesNotThrow(() => createWorktreeForGroup(repoRoot, group, "run-2"));
});

test("test_createWorktreeForGroupResetsAReusableWorktreeToTheStagingTip", () => {
    // Setup: a first run cut the folder at the common base B and released its lease.
    const repoRoot = makeTempRepoWithCommit();
    const originalBranch = git(repoRoot, "branch", "--show-current").trim();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const firstWorktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    releaseTaskWorktreeLease({ worktreePath: firstWorktreePath, runId: "run-1" });
    // Setup: staging moves to S; the original branch moves to a different commit O.
    git(repoRoot, "checkout", "-q", "staging");
    writeFileSync(join(repoRoot, "staging-only.txt"), "staging work\n");
    git(repoRoot, "add", "staging-only.txt");
    git(repoRoot, "commit", "-q", "-m", "S");
    const stagingTip = git(repoRoot, "rev-parse", "refs/heads/staging").trim();
    git(repoRoot, "checkout", "-q", originalBranch);
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    // Test action: a second run reuses the folder.
    const secondWorktreePath = createWorktreeForGroup(repoRoot, group, "run-2");
    // Verification: the folder sits at S, holds the staging-only file, and lacks the original-only file.
    assert.equal(git(secondWorktreePath, "rev-parse", "HEAD").trim(), stagingTip);
    assert.equal(existsSync(join(secondWorktreePath, "staging-only.txt")), true);
    assert.equal(existsSync(join(secondWorktreePath, "original-only.txt")), false);
});

test("test_createWorktreeForGroupSelectsTheStagingBranchOverAStagingTag", () => {
    // Setup: staging branch holds unmerged commit B; a tag named staging sits at commit O.
    const repoRoot = makeTempRepoWithCommit();
    const originalBranch = git(repoRoot, "branch", "--show-current").trim();
    git(repoRoot, "checkout", "-q", "-b", "staging");
    writeFileSync(join(repoRoot, "staging-only.txt"), "staging work\n");
    git(repoRoot, "add", "staging-only.txt");
    git(repoRoot, "commit", "-q", "-m", "B");
    const branchTip = git(repoRoot, "rev-parse", "refs/heads/staging").trim();
    git(repoRoot, "checkout", "-q", originalBranch);
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    git(repoRoot, "tag", "staging");
    // Test action: a fresh cut, then a reuse.
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const firstWorktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    const firstHead = git(firstWorktreePath, "rev-parse", "HEAD").trim();
    releaseTaskWorktreeLease({ worktreePath: firstWorktreePath, runId: "run-1" });
    const secondWorktreePath = createWorktreeForGroup(repoRoot, group, "run-2");
    // Verification: both cuts sit at the branch commit, never the tag commit.
    assert.equal(firstHead, branchTip);
    assert.equal(git(secondWorktreePath, "rev-parse", "HEAD").trim(), branchTip);
});

test("test_createWorktreeForGroupRefusesWhenTheHiddenTaskBranchHoldsRetainedWork", () => {
    // Setup: a first run committed R on task-1, then moved the folder to a clean detached HEAD.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    writeFileSync(join(worktreePath, "retained.txt"), "retained\n");
    git(worktreePath, "add", "retained.txt");
    git(worktreePath, "commit", "-q", "-m", "R");
    const retainedTip = git(repoRoot, "rev-parse", "refs/heads/task-1").trim();
    git(worktreePath, "checkout", "-q", "--detach", "refs/heads/staging");
    releaseTaskWorktreeLease({ worktreePath, runId: "run-1" });
    // Test action and verification: reuse refuses, and task-1 still points at R.
    assert.throws(() => createWorktreeForGroup(repoRoot, group, "run-2"), /retained work/);
    assert.equal(git(repoRoot, "rev-parse", "refs/heads/task-1").trim(), retainedTip);
});

test("test_createWorktreeForGroupRefusesToRecreateOverAnUnmergedTaskBranch", () => {
    // Setup: a first run committed R on task-1; its folder was removed but the branch stayed.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    writeFileSync(join(worktreePath, "retained.txt"), "retained\n");
    git(worktreePath, "add", "retained.txt");
    git(worktreePath, "commit", "-q", "-m", "R");
    const retainedTip = git(repoRoot, "rev-parse", "refs/heads/task-1").trim();
    releaseTaskWorktreeLease({ worktreePath, runId: "run-1" });
    git(repoRoot, "worktree", "remove", "--force", worktreePath);
    assert.equal(existsSync(worktreePath), false);
    // Test action and verification: the fresh path refuses, and task-1 still points at R.
    assert.throws(() => createWorktreeForGroup(repoRoot, group, "run-2"), /retained work/);
    assert.equal(git(repoRoot, "rev-parse", "refs/heads/task-1").trim(), retainedTip);
});

test("test_createWorktreeForGroupRefusesWhenASubmoduleTaskBranchHoldsRetainedWork", () => {
    // Setup: a first run committed R on the submodule's task-1, then reset it to a clean gitlink commit.
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    const submodulePath = join(worktreePath, "vendor");
    const gitlinkTip = git(worktreePath, "rev-parse", "HEAD:vendor").trim();
    writeFileSync(join(submodulePath, "retained.txt"), "retained\n");
    git(submodulePath, "add", "retained.txt");
    git(submodulePath, "commit", "-q", "-m", "R");
    const retainedTip = git(submodulePath, "rev-parse", "refs/heads/task-1").trim();
    git(submodulePath, "checkout", "-q", "--detach", gitlinkTip);
    releaseTaskWorktreeLease({ worktreePath, runId: "run-1" });
    // Test action and verification: reuse refuses, and the submodule's task-1 still points at R.
    assert.throws(() => createWorktreeForGroup(repoRoot, group, "run-2"), /retained work/);
    assert.equal(git(submodulePath, "rev-parse", "refs/heads/task-1").trim(), retainedTip);
});

test("test_createWorktreeForGroupRefusesWhenTheWorktreeHoldsAnUntrackedFile", () => {
    // Setup: a first run left an untracked file behind and released its lease.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    writeFileSync(join(worktreePath, "untracked.txt"), "not yet added\n");
    releaseTaskWorktreeLease({ worktreePath, runId: "run-1" });
    // Test action and verification: reuse refuses, and the file survives.
    assert.throws(() => createWorktreeForGroup(repoRoot, group, "run-2"), /retained work/);
    assert.equal(existsSync(join(worktreePath, "untracked.txt")), true);
});

test("test_recoverStaleTaskWorktreeLeaseJudgesRetainedWorkAgainstStaging", () => {
    // Setup: staging holds S, the original branch holds O, and a crashed run left its lease at S.
    const repoRoot = makeTempRepoWithCommit();
    const originalBranch = git(repoRoot, "branch", "--show-current").trim();
    git(repoRoot, "checkout", "-q", "-b", "staging");
    writeFileSync(join(repoRoot, "staging-only.txt"), "staging work\n");
    git(repoRoot, "add", "staging-only.txt");
    git(repoRoot, "commit", "-q", "-m", "S");
    git(repoRoot, "checkout", "-q", originalBranch);
    writeFileSync(join(repoRoot, "original-only.txt"), "original work\n");
    git(repoRoot, "add", "original-only.txt");
    git(repoRoot, "commit", "-q", "-m", "O");
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "stale-run");
    // Test action and verification: recovery releases the lease instead of calling S retained.
    assert.doesNotThrow(() => recoverStaleTaskWorktreeLease(repoRoot, worktreePath));
    assert.equal(existsSync(`${worktreePath}.lease`), false);
});

test("test_recoverStaleTaskWorktreeLeaseRefusesWhenStagingIsMissing", () => {
    // Setup: a crashed run left its lease; the staging branch is gone.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "stale-run");
    git(repoRoot, "branch", "-D", "staging");
    // Test action and verification: recovery refuses and leaves the lease in place.
    assert.throws(() => recoverStaleTaskWorktreeLease(repoRoot, worktreePath), /staging branch is missing/);
    assert.equal(existsSync(`${worktreePath}.lease`), true);
});

test("test_twoPrepareProcessesWithNoStagingBranchBothStartFromTheSameStagingTip", async () => {
    // Setup: a repo with no staging branch, and two prepare processes for two different groups held at a barrier.
    const repoRoot = makeTempRepoWithCommit();
    const headTip = git(repoRoot, "rev-parse", "HEAD").trim();
    const readyA = join(repoRoot, "ready-a");
    const readyB = join(repoRoot, "ready-b");
    const goFile = join(repoRoot, "go");
    const a = spawnLeaseRacer(repoRoot, 1, "run-a", readyA, goFile);
    const b = spawnLeaseRacer(repoRoot, 2, "run-b", readyB, goFile);
    try {
        await waitForPath(readyA);
        await waitForPath(readyB);
        // Test action: release both at once.
        writeFileSync(goFile, "go\n");
        const [outA, outB] = await Promise.all([captureSuccessfulChild(a), captureSuccessfulChild(b)]);
        const results = [JSON.parse(outA), JSON.parse(outB)] as Array<{ ok: boolean, worktreePath?: string, message?: string }>;
        // Verification: both succeed, staging exists at HEAD, and both folders sit at that tip.
        assert.equal(results[0]!.ok, true, results[0]!.message ?? "");
        assert.equal(results[1]!.ok, true, results[1]!.message ?? "");
        assert.equal(git(repoRoot, "rev-parse", "refs/heads/staging").trim(), headTip);
        assert.equal(git(results[0]!.worktreePath!, "rev-parse", "HEAD").trim(), headTip);
        assert.equal(git(results[1]!.worktreePath!, "rev-parse", "HEAD").trim(), headTip);
    } finally {
        rmSync(resolveTaskWorktreeConventionDirectory(repoRoot), { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
    }
});

// Real processes, not sequential same-process calls: both block on one "go" file, a genuine race.
function spawnLeaseRacer(repoRoot: string, groupId: number, runId: string, readyFile: string, goFile: string): ChildProcess {
    const prepareTasksUrl = pathToFileURL(join(import.meta.dirname, "..", "scripts", "prepareTasks.ts")).href;
    const source = `
      import { createWorktreeForGroup } from ${JSON.stringify(prepareTasksUrl)};
      import { existsSync, writeFileSync } from "node:fs";
      const wait = new Int32Array(new SharedArrayBuffer(4));
      writeFileSync(${JSON.stringify(readyFile)}, "ready\\n");
      while (!existsSync(${JSON.stringify(goFile)})) Atomics.wait(wait, 0, 0, 5);
      try {
        const worktreePath = createWorktreeForGroup(
          ${JSON.stringify(repoRoot)},
          { groupId: ${groupId}, taskNumbers: [${groupId}], filePaths: [], scope: "unknown" },
          ${JSON.stringify(runId)},
        );
        process.stdout.write(JSON.stringify({ ok: true, worktreePath }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, message: String(error.message) }));
      }
    `;
    return spawn(process.execPath, ["--input-type=module", "--eval", source], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
}

test("test_twoBarrierSynchronizedPrepareProcessesHaveExactlyOneOwnerOfTheSameCleanWorktree", async () => {
    const repoRoot = makeTempRepoWithCommit();
    const readyA = join(repoRoot, "ready-a");
    const readyB = join(repoRoot, "ready-b");
    const goFile = join(repoRoot, "go");
    const a = spawnLeaseRacer(repoRoot, 1, "run-a", readyA, goFile);
    const b = spawnLeaseRacer(repoRoot, 1, "run-b", readyB, goFile);
    try {
        await waitForPath(readyA);
        await waitForPath(readyB);
        writeFileSync(goFile, "go\n");
        const [outA, outB] = await Promise.all([captureSuccessfulChild(a), captureSuccessfulChild(b)]);
        const results = [JSON.parse(outA), JSON.parse(outB)] as Array<{ ok: boolean, worktreePath?: string, message?: string }>;
        const winners = results.filter((r) => r.ok);
        const losers = results.filter((r) => !r.ok);
        // Exactly one owner: the other fails outright, never resetting or sharing the checkout.
        assert.equal(winners.length, 1);
        assert.equal(losers.length, 1);
        assert.match(losers[0]!.message!, /already owned by a live run/);
        const worktreePath = winners[0]!.worktreePath!;
        const leaseOwner = JSON.parse(readFileSync(`${worktreePath}.lease`, "utf8")) as { runId: string };
        assert.ok(leaseOwner.runId === "run-a" || leaseOwner.runId === "run-b");
        assert.equal(existsSync(worktreePath), true);
    } finally {
        rmSync(resolveTaskWorktreeConventionDirectory(repoRoot), { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
    }
});

test("test_createWorktreeForGroupRefusesToDiscardAStaleWorktreesRetainedWork", () => {
    // Setup: a worktree left behind by an earlier run, holding that run's commit.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "run-1");
    writeFileSync(join(worktreePath, "stale.txt"), "from the previous run\n");
    git(worktreePath, "add", "stale.txt");
    git(worktreePath, "commit", "-q", "-m", "previous run");
    const retainedHead = git(worktreePath, "rev-parse", "HEAD").trim();
    // Setup: the source branch has since moved on.
    writeFileSync(join(repoRoot, "fresh.txt"), "landed since\n");
    git(repoRoot, "add", "fresh.txt");
    git(repoRoot, "commit", "-q", "-m", "fresh work");
    // The lease is taken before the retained-work check; a held lease refuses on ownership instead.
    releaseTaskWorktreeLease({ worktreePath, runId: "run-1" });
    // Test action and verification: re-preparation refuses to silently discard retained work.
    assert.throws(() => createWorktreeForGroup(repoRoot, group), /retained work/);
    // Verification: the previous run's commit and file are still there for inspection or recovery.
    assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), retainedHead);
    assert.equal(existsSync(join(worktreePath, "stale.txt")), true);
});

test("test_createWorktreeForGroupPopulatesSubmoduleWorkingTrees", () => {
    // Setup: a repo whose `vendor/` submodule holds a file with a known marker.
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    // Test action: create the worktree a worker agent would be handed.
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    // Verification: the submodule directory holds its files instead of being empty.
    assert.equal(existsSync(join(worktreePath, "vendor", "inner.txt")), true);
});

test("test_createWorktreeForGroupThrowsWhenSubmoduleInitFails", () => {
    // Setup: a repo with a submodule whose origin no longer exists on disk.
    const { repoRoot, submoduleOrigin } = makeTempRepoWithLocalSubmodule();
    rmSync(submoduleOrigin, { recursive: true, force: true });
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    // Verification: the run stops rather than handing a worker a half-populated worktree.
    assert.throws(() => createWorktreeForGroup(repoRoot, group));
    // Verification: failed preparation released its own lease instead of orphaning it.
    const worktreePath = join(resolveTaskWorktreeConventionDirectory(repoRoot), "task-1");
    assert.equal(existsSync(`${worktreePath}.lease`), false);
});

test("test_recoverStaleTaskWorktreeLeaseRefusesWhenRetainedWorkExists", () => {
    // Setup: a crashed run left both a lease and retained work behind.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "stale-run");
    writeFileSync(join(worktreePath, "stale.txt"), "from the crashed run\n");
    git(worktreePath, "add", "stale.txt");
    git(worktreePath, "commit", "-q", "-m", "crashed run work");
    // Test action and verification: recovery refuses a deliberate takeover over retained work.
    assert.throws(() => recoverStaleTaskWorktreeLease(repoRoot, worktreePath), /retained work/);
    // Verification: both the lease and the retained commit survive the refusal.
    assert.equal(existsSync(`${worktreePath}.lease`), true);
    assert.equal(existsSync(join(worktreePath, "stale.txt")), true);
});

test("test_recoverStaleTaskWorktreeLeaseReleasesACleanStaleLease", () => {
    // Setup: a crashed run left a lease behind but no retained work.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group, "stale-run");
    // Test action: explicit recovery, the only way to take over a lease this process didn't acquire.
    recoverStaleTaskWorktreeLease(repoRoot, worktreePath);
    assert.equal(existsSync(`${worktreePath}.lease`), false);
    // Verification: ordinary preparation can now proceed as normal reuse.
    const reused = createWorktreeForGroup(repoRoot, group, "new-run");
    assert.equal(reused, worktreePath);
});

test("test_recoverStaleTaskWorktreeLeaseRemovesALeaseWhoseWorktreeIsAlreadyGone", () => {
    // Setup: a crashed run's cleanup removed the worktree but not its sibling lease file.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = join(resolveTaskWorktreeConventionDirectory(repoRoot), "task-1");
    mkdirSync(dirname(worktreePath), { recursive: true });
    writeFileSync(`${worktreePath}.lease`, JSON.stringify({ runId: "stale-run", pid: 1, createdAt: Date.now() }));
    assert.equal(existsSync(worktreePath), false);
    // Test action: recovery must not run git status against an absent worktree.
    recoverStaleTaskWorktreeLease(repoRoot, worktreePath);
    assert.equal(existsSync(`${worktreePath}.lease`), false);
    // Verification: the freed path is acquirable by a normal prepare.
    const reused = createWorktreeForGroup(repoRoot, group, "new-run");
    assert.equal(reused, worktreePath);
});

test("test_buildWorkflowArgumentsDictatesThePlanFilePathForEveryTask", () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskRecords: TaskRecord[] = [
        { taskNumber: 268, files: ["a.ts"] },
        { taskNumber: 270, files: ["b.ts"] },
    ];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords);
    const tasks = workflowArguments.groups.flatMap((g) => g.tasks);
    assert.match(tasks.find((t) => t.number === 268)!.planFile, /plans\/task-268-plan\.md$/);
    assert.match(tasks.find((t) => t.number === 270)!.planFile, /plans\/task-270-plan\.md$/);
});

test("test_buildWorkflowArgumentsProducesIdenticalOutputForIdenticalInput", () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskRecords: TaskRecord[] = [{ taskNumber: 1, files: ["a.ts"] }];
    const first = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords, "run-1");
    releaseTaskWorktreeLease({ worktreePath: first.groups[0]!.worktree, runId: "run-1" });
    const second = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords, "run-2");
    assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("test_buildWorkflowArgumentsRollsBackEarlierCandidateLeasesWhenALaterTaskHasAForeignLease", () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskRecords: TaskRecord[] = [
        { taskNumber: 1, files: ["a.ts"] },
        { taskNumber: 2, files: ["b.ts"] },
    ];
    const worktree1 = join(resolveTaskWorktreeConventionDirectory(repoRoot), "task-1");
    const worktree2 = join(resolveTaskWorktreeConventionDirectory(repoRoot), "task-2");
    mkdirSync(dirname(worktree2), { recursive: true });
    const foreignLeaseContents = JSON.stringify({ runId: "foreign-run", pid: 1, createdAt: 1 });
    writeFileSync(`${worktree2}.lease`, foreignLeaseContents);

    assert.throws(() => buildWorkflowArguments(repoRoot, "true", taskRecords, "candidate-run"));
    // Task 1's candidate lease was rolled back; task 2's foreign lease is untouched.
    assert.equal(existsSync(`${worktree1}.lease`), false);
    assert.equal(readFileSync(`${worktree2}.lease`, "utf8"), foreignLeaseContents);

    rmSync(`${worktree2}.lease`);
    const retried = buildWorkflowArguments(repoRoot, "true", taskRecords, "retry-run");
    assert.equal(retried.groups.length, 2);
});

test("test_generateRunIdIsALocalTimestampToTheMillisecond", () => {
    assert.match(generateRunId(), /^\d{8}-\d{6}\.\d{3}$/);
});

test("test_mergeScriptPathPointsAtTheSiblingMergeScriptAsAnAbsolutePath", () => {
    const path = resolveMergeScriptPath();
    assert.equal(isAbsolute(path), true);
    assert.match(path, /mergeTaskWorktrees\.ts$/);
});

test("test_selectRequestedTasksRefusesToRunWhenNoTaskNumbersWereGiven", () => {
    // Setup: two open tasks and an empty requested-numbers list.
    const openTasks = [{ taskNumber: 1 }, { taskNumber: 2 }];
    // Verification: throws instead of falling back to every open task.
    assert.throws(() => selectRequestedTasks(openTasks, []), /no task numbers/i);
});

test("test_selectRequestedTasksRefusesWhenARequestedNumberIsNotOpen", () => {
    // Setup: open tasks 1 and 2, with 9 requested alongside them.
    const openTasks = [{ taskNumber: 1 }, { taskNumber: 2 }];
    // Test action and verification: the missing number is named in the error, rather than dropped.
    assert.throws(() => selectRequestedTasks(openTasks, [1, 9]), /9/);
});

test("test_selectRequestedTasksExcludesTasksBlockedByAnOpenTask", () => {
    // Setup: task 2 is blocked by open task 1; both are requested.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [{ taskNumber: 1, reason: "needs task 1" }], files: ["b.ts"] }];
    // Test action: select both requested tasks.
    const selected = selectRequestedTasks(openTasks, [1, 2]);
    // Verification: only the unblocked task survives, so no worktree is built for blocked work.
    assert.deepEqual(selected.map((t) => t.taskNumber), [1]);
});

test("test_selectRequestedTasksRefusesTasksWithNoFilesArray", () => {
    // Setup: task 1 declares files, task 2 has no files key at all; both are requested.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2 }];
    // Verification: the run stops, names only the undeclared task, and points at modifiableFiles, never the legacy "files" key.
    let message = "";
    try { selectRequestedTasks(openTasks, [1, 2]); } catch (error) { message = (error as Error).message; }
    assert.match(message, /\b2\b/);
    assert.match(message, /"modifiableFiles"/);
    assert.doesNotMatch(message, /"files"/);
});

test("test_selectRequestedTasksTreatsAnEmptyFilesArrayAsUndeclared", () => {
    // Setup: task 1 carries an explicitly empty files array.
    const openTasks = [{ taskNumber: 1, files: [] }];
    // Verification: an empty array is refused like a missing one; message names modifiableFiles, never "files".
    let message = "";
    try { selectRequestedTasks(openTasks, [1]); } catch (error) { message = (error as Error).message; }
    assert.match(message, /"modifiableFiles"/);
    assert.doesNotMatch(message, /"files"/);
});

test("test_selectRequestedTasksIgnoresMissingFilesOnABlockedTask", () => {
    // Setup: task 2 is blocked by open task 1 and declares no files; task 1 declares files.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [{ taskNumber: 1, reason: "needs task 1" }] }];
    // Test action: select both requested tasks.
    const selected = selectRequestedTasks(openTasks, [1, 2]);
    // Verification: the blocked task is dropped before the files check, not stopping the run.
    assert.deepEqual(selected.map((t) => t.taskNumber), [1]);
});

test("test_selectRequestedTasksPointsAtTheUpdateTaskFilesSkillThatActuallyExists", () => {
    // Setup: one requested task with no files, and the skill directory on disk.
    const openTasks = [{ taskNumber: 7 }];
    // Test action: capture the refusal message.
    let message = "";
    try { selectRequestedTasks(openTasks, [7]); } catch (error) { message = (error as Error).message; }
    // Verification: message names update-task-files and modifiableFiles, never "files"; the SKILL.md still exists.
    assert.match(message, /update-task-files/);
    assert.match(message, /"modifiableFiles"/);
    assert.doesNotMatch(message, /"files"/);
    assert.ok(existsSync(join(import.meta.dirname, "..", "skills", "update-task-files", "SKILL.md")));
});

test("test_modifiableFilesFallsBackToTheLegacyFilesKeyWhenModifiableFilesIsAbsent", () => {
    // Verification: a legacy task with only "files" still resolves through the modifiable accessor.
    assert.deepEqual(modifiableFiles({ taskNumber: 1, files: ["a.ts"] }), ["a.ts"]);
});

test("test_modifiableFilesPrefersTheModifiableFilesKeyWhenPresent", () => {
    // Verification: the new "modifiableFiles" key takes precedence over the legacy "files" key, even when both are declared.
    assert.deepEqual(modifiableFiles({ taskNumber: 1, modifiableFiles: ["a.ts"], files: ["legacy.ts"] } as TaskRecord), ["a.ts"]);
});

test("test_readOnlyFilesDefaultsToWildcardWhenAbsent", () => {
    // Verification: an absent read fence widens to "*" rather than narrowing to the modifiable files.
    assert.deepEqual(readOnlyFiles({ taskNumber: 1, files: ["a.ts"] }), ["*"]);
});

test("test_readOnlyFilesReturnsTheDeclaredReadOnlyFilesKeyWhenPresent", () => {
    // Verification: a declared "readOnlyFiles" key is returned as-is.
    assert.deepEqual(readOnlyFiles({ taskNumber: 1, readOnlyFiles: ["b.ts"] } as TaskRecord), ["b.ts"]);
});

test("test_modifiableFilesAndReadOnlyFilesResolveIdenticallyForAModernTaskAndItsLegacyEquivalent", () => {
    // Setup: a modern task that declares both keys, and a legacy task that only declares "files".
    const modernTask = { taskNumber: 1, modifiableFiles: ["a.ts"], readOnlyFiles: ["*"] } as TaskRecord;
    const legacyTask = { taskNumber: 2, files: ["a.ts"] } as TaskRecord;
    // Verification: the legacy fallback is invisible downstream — both resolve to the same values.
    assert.deepEqual(modifiableFiles(modernTask), modifiableFiles(legacyTask));
    assert.deepEqual(readOnlyFiles(modernTask), readOnlyFiles(legacyTask));
});

test("test_loadPreparedTaskCarriesReadOnlyFilesFromTheTaskRecordThroughToThePreparedTask", () => {
    // Setup: a task declaring readOnlyFiles, its brief, and the .taskTools files loadPreparedTask reads.
    const repoRoot = makeTempRepoWithCommit();
    const taskDirectory = join(repoRoot, ".taskTools");
    mkdirSync(taskDirectory, { recursive: true });
    const task = { taskNumber: 1, title: "t1", description: "desc", files: ["a.ts"], readOnlyFiles: ["b.ts"] };
    writeFileSync(join(taskDirectory, "tasks.json"), JSON.stringify([task]));
    writeFileSync(join(taskDirectory, "completedTasks.json"), "[]\n");
    writeTaskBriefFile(task, repoRoot);
    // Verification: the field survives from the task record through loadPreparedTask's construction site.
    const prepared = loadPreparedTask(1, repoRoot, repoRoot);
    assert.deepEqual(prepared.readOnlyFiles, ["b.ts"]);
});

test("test_createWorktreeForGroupPutsSubmoduleOnTheGroupBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    const branch = git(join(worktreePath, "vendor"), "branch", "--show-current").trim();
    assert.equal(branch, "task-1");
});

test("test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    git(join(repoRoot, "vendor"), "checkout", "--detach", "HEAD");
    const taskRecords: TaskRecord[] = [{ taskNumber: 1, files: ["a.ts"] }];
    assert.throws(() => buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords));
    assert.equal(existsSync(join(resolveTaskWorktreeConventionDirectory(repoRoot), "task-1")), false);
});

test("test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const taskRecords: TaskRecord[] = [{ taskNumber: 1, files: ["a.ts"] }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords);
    const paths = workflowArguments.repositorySources.map((source) => source.path);
    assert.ok(paths.includes(""));
    assert.ok(paths.includes("vendor"));
});

test("test_buildWorkflowArgumentsGivesEachTaskItsOwnFilesNotTheCombinedList", () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskRecords: TaskRecord[] = [
        { taskNumber: 1, files: ["a.ts"] },
        { taskNumber: 2, files: ["b.ts"] },
    ];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords);
    const tasks = workflowArguments.groups.flatMap((g) => g.tasks);
    assert.deepEqual(tasks.find((t) => t.number === 1)!.files, ["a.ts"]);
    assert.deepEqual(tasks.find((t) => t.number === 2)!.files, ["b.ts"]);
});

test("test_buildWorkflowArgumentsCarriesReadOnlyFilesThroughToThePrintedPipelineArgs", () => {
    // Verification: readOnlyFiles survives from the type through buildWorkflowArguments's construction site.
    const repoRoot = makeTempRepoWithCommit();
    const taskRecords: TaskRecord[] = [{ taskNumber: 1, files: ["a.ts"], readOnlyFiles: ["b.ts"] } as TaskRecord];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords);
    assert.deepEqual(workflowArguments.groups[0]!.tasks[0]!.readOnlyFiles, ["b.ts"]);
});

test("test_buildWorkflowArgumentsGivesEachTaskItsOwnWorktreeAndBranchAsASingletonGroup", () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskRecords: TaskRecord[] = [
        { taskNumber: 1, files: ["a.ts"] },
        { taskNumber: 2, files: ["b.ts"] },
    ];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", taskRecords);
    assert.equal(workflowArguments.groups.length, 2);
    const group1 = workflowArguments.groups.find((g) => g.tasks[0].number === 1)!;
    const group2 = workflowArguments.groups.find((g) => g.tasks[0].number === 2)!;
    assert.equal(group1.tasks.length, 1);
    assert.equal(group2.tasks.length, 1);
    assert.notEqual(group1.worktree, group2.worktree);
    assert.match(group1.worktree, /task-1$/);
    assert.match(group2.worktree, /task-2$/);
    assert.equal(group1.branch, "task-1");
    assert.equal(group2.branch, "task-2");
});

type PipelineView = {
    groups: Array<{ tasks: Array<{ number: number; files: string[] }> }>;
};

function captureSuccessfulChild(child: ChildProcess): Promise<string> {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    return (async () => {
        const [code, signal] = await once(child, "exit");
        if (code !== 0 || signal !== null) {
            throw new Error(`child failed: code=${String(code)} signal=${String(signal)} stderr=${stderr}`);
        }
        return stdout;
    })();
}

async function waitForPath(path: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function filesFor(pipeline: PipelineView, taskNumber: number): string[] {
    return pipeline.groups
        .flatMap((group) => group.tasks)
        .find((task) => task.number === taskNumber)!.files;
}

test("prepareTasks publishes a widening that lands under the task-state lock", async () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskNumber = 1;
    const taskDirectory = join(repoRoot, ".taskTools");
    const tasksPath = join(taskDirectory, "tasks.json");
    const readyFile = join(repoRoot, "widener-ready");
    const releaseFile = join(repoRoot, "release-widener");
    const worktreePath = join(resolveTaskWorktreeConventionDirectory(repoRoot), `task-${taskNumber}`);
    let widener: ChildProcess | undefined;
    let prepare: ChildProcess | undefined;

    try {
        writeFileSync(join(repoRoot, "existing.ts"), "existing\n");
        writeFileSync(join(repoRoot, "widened.ts"), "widened\n");
        git(repoRoot, "add", "existing.ts", "widened.ts");
        git(repoRoot, "commit", "-q", "-m", "add task files");
        mkdirSync(taskDirectory, { recursive: true });
        writeFileSync(tasksPath, JSON.stringify([
            { taskNumber, title: "fixture", files: ["existing.ts"], blockedBy: [] },
        ]));
        writeFileSync(join(taskDirectory, "completedTasks.json"), "[]\n");
        git(repoRoot, "remote", "add", "origin", repoRoot);

        const lockModuleUrl = pathToFileURL(
            join(import.meta.dirname, "..", "scripts", "taskStateLock.ts"),
        ).href;
        const widenerSource = `
          import { existsSync, readFileSync, writeFileSync } from "node:fs";
          import { withTaskStateLock, writeJsonAtomically } from ${JSON.stringify(lockModuleUrl)};
          const wait = new Int32Array(new SharedArrayBuffer(4));
          const tasksPath = ${JSON.stringify(tasksPath)};
          withTaskStateLock(tasksPath, () => {
            writeFileSync(${JSON.stringify(readyFile)}, "ready\\n");
            while (!existsSync(${JSON.stringify(releaseFile)})) Atomics.wait(wait, 0, 0, 10);
            const tasks = JSON.parse(readFileSync(tasksPath, "utf8"));
            tasks[0].files.push("widened.ts");
            writeJsonAtomically(tasksPath, tasks);
          });
        `;
        widener = spawn(process.execPath, ["--input-type=module", "--eval", widenerSource], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const widenerDone = captureSuccessfulChild(widener);
        await waitForPath(readyFile);

        prepare = spawn(
            process.execPath,
            [join(import.meta.dirname, "..", "scripts", "prepareTasks.ts"), String(taskNumber)],
            { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
        const prepareDone = captureSuccessfulChild(prepare);

        // Worktree creation happens before the publication lock; seeing it proves the CLI's original snapshot.
        await waitForPath(worktreePath);
        writeFileSync(releaseFile, "go\n");

        await widenerDone;
        const emitted = JSON.parse(await prepareDone) as PipelineView;
        const published = JSON.parse(
            readFileSync(join(taskDirectory, "run-arguments.json"), "utf8"),
        ) as PipelineView;
        assert.deepEqual(filesFor(emitted, taskNumber), ["existing.ts", "widened.ts"]);
        assert.deepEqual(filesFor(published, taskNumber), ["existing.ts", "widened.ts"]);
    } finally {
        if (!existsSync(releaseFile)) writeFileSync(releaseFile, "cleanup\n");
        widener?.kill();
        prepare?.kill();
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
    }
});

function waitForExitCode(child: ChildProcess): Promise<number | null> {
    return (async () => {
        const [code] = await once(child, "exit");
        return code as number | null;
    })();
}

// C86-45: a failure publishing run-arguments.json must not strand the leases acquired for this batch.
test("prepareTasks CLI rolls back every candidate lease when run-arguments publication fails, then a retry succeeds", async () => {
    const repoRoot = makeTempRepoWithCommit();
    const taskDirectory = join(repoRoot, ".taskTools");
    const argumentsFile = join(taskDirectory, "run-arguments.json");
    const worktree1 = join(resolveTaskWorktreeConventionDirectory(repoRoot), "task-1");
    const worktree2 = join(resolveTaskWorktreeConventionDirectory(repoRoot), "task-2");

    try {
        writeFileSync(join(repoRoot, "a.ts"), "a\n");
        writeFileSync(join(repoRoot, "b.ts"), "b\n");
        git(repoRoot, "add", "a.ts", "b.ts");
        git(repoRoot, "commit", "-q", "-m", "add task files");
        mkdirSync(taskDirectory, { recursive: true });
        writeFileSync(join(taskDirectory, "tasks.json"), JSON.stringify([
            { taskNumber: 1, title: "one", files: ["a.ts"], blockedBy: [] },
            { taskNumber: 2, title: "two", files: ["b.ts"], blockedBy: [] },
        ]));
        writeFileSync(join(taskDirectory, "completedTasks.json"), "[]\n");
        git(repoRoot, "remote", "add", "origin", repoRoot);
        // A directory in place of the target file makes writeJsonAtomically's final rename fail.
        mkdirSync(argumentsFile, { recursive: true });

        const failing = spawn(
            process.execPath,
            [join(import.meta.dirname, "..", "scripts", "prepareTasks.ts"), "[1,2]"],
            { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] },
        );
        const failingCode = await waitForExitCode(failing);
        assert.notEqual(failingCode, 0);
        assert.equal(existsSync(`${worktree1}.lease`), false);
        assert.equal(existsSync(`${worktree2}.lease`), false);

        rmSync(argumentsFile, { recursive: true, force: true });
        const retry = spawn(
            process.execPath,
            [join(import.meta.dirname, "..", "scripts", "prepareTasks.ts"), "[1,2]"],
            { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
        const retryDone = captureSuccessfulChild(retry);
        const emitted = JSON.parse(await retryDone) as PipelineView;
        assert.equal(emitted.groups.length, 2);
    } finally {
        rmSync(worktree1, { recursive: true, force: true });
        rmSync(worktree2, { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Finding 4: current and archived workflow materialization must never converge.
// ---------------------------------------------------------------------------

// Catches the defect: output depends only on templatePath, and the archived brief cites only its own field.
test("current and archived materialized files each carry their own marker, and the archived emitter names only its own field", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-workflow-markers-"));
    const currentTemplate = join(dir, "current.workflow.js");
    const v1_1Template = join(dir, "v1_1.workflow.js");
    writeFileSync(currentTemplate, 'export const meta = {\n  name: "task-__TT_TASK__",\n};\n// MARKER_CURRENT\n');
    writeFileSync(v1_1Template, 'export const meta = {\n  name: "task-__TT_TASK__",\n};\n// MARKER_V1_1\n');
    const worktree = join(dir, "task-42");

    const workflowPath = materializeTaskWorkflow(42, currentTemplate, currentWorkflowOutputPath(worktree));
    const v1_1WorkflowPath = materializeTaskWorkflow(42, v1_1Template, v1_1WorkflowOutputPath(worktree));

    assert.notEqual(workflowPath, v1_1WorkflowPath);
    assert.match(readFileSync(workflowPath, "utf8"), /MARKER_CURRENT/);
    assert.doesNotMatch(readFileSync(workflowPath, "utf8"), /MARKER_V1_1/);
    assert.match(readFileSync(v1_1WorkflowPath, "utf8"), /MARKER_V1_1/);
    assert.doesNotMatch(readFileSync(v1_1WorkflowPath, "utf8"), /MARKER_CURRENT/);

    const archivedBrief = v1_1SkillBody("[1]");
    assert.match(archivedBrief, /`v1_1WorkflowPath`/);
    assert.doesNotMatch(archivedBrief, /\bworkflowPath\b/);
});

// Proves the archived output's bytes never move when only the current template changes.
test("materializeTaskWorkflow's archived output is unaffected by a change to the current template", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-workflow-independence-"));
    const v1_1Template = join(dir, "v1_1.workflow.js");
    writeFileSync(v1_1Template, 'export const meta = {\n  name: "task-__TT_TASK__",\n};\n// ARCHIVED\n');
    const worktreeA = join(dir, "task-1");
    const worktreeB = join(dir, "task-2");

    const currentTemplateV1 = join(dir, "current-v1.workflow.js");
    writeFileSync(currentTemplateV1, 'export const meta = {\n  name: "task-__TT_TASK__",\n};\n// CURRENT_V1\n');
    const archivedOutputA = materializeTaskWorkflow(1, v1_1Template, v1_1WorkflowOutputPath(worktreeA));
    materializeTaskWorkflow(1, currentTemplateV1, currentWorkflowOutputPath(worktreeA));

    // The current template "changes" — a distinct template stands in for that edit.
    const currentTemplateV2 = join(dir, "current-v2.workflow.js");
    writeFileSync(currentTemplateV2, 'export const meta = {\n  name: "task-__TT_TASK__",\n};\n// CURRENT_V2_EDITED\n');
    const archivedOutputB = materializeTaskWorkflow(1, v1_1Template, v1_1WorkflowOutputPath(worktreeB));
    materializeTaskWorkflow(1, currentTemplateV2, currentWorkflowOutputPath(worktreeB));

    assert.equal(readFileSync(archivedOutputA, "utf8"), readFileSync(archivedOutputB, "utf8"));

    // The archived brief text has no file dependency at all, so it stays byte-identical too.
    assert.equal(v1_1SkillBody("[1]"), v1_1SkillBody("[1]"));
});

test("buildWorkflowArguments releases the worktree lease and leaves no sibling file when the first materialization call fails", () => {
    const repoRoot = makeTempRepoWithCommit();
    const worktree = join(resolveTaskWorktreeConventionDirectory(repoRoot), "task-1");
    const currentOutput = currentWorkflowOutputPath(worktree);
    const v1_1Output = v1_1WorkflowOutputPath(worktree);
    mkdirSync(dirname(currentOutput), { recursive: true });
    // Pre-existing read-only file at the current output path forces writeFileSync to fail there.
    writeFileSync(currentOutput, "blocked\n", { mode: 0o444 });

    try {
        assert.throws(() => buildWorkflowArguments(repoRoot, "true", [{ taskNumber: 1, files: ["seed.txt"] }]));
        assert.equal(existsSync(`${worktree}.lease`), false);
        assert.equal(existsSync(currentOutput), false);
        assert.equal(existsSync(v1_1Output), false);
    } finally {
        rmSync(worktree, { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
    }
});

test("buildWorkflowArguments releases the worktree lease and leaves no sibling file when the second materialization call fails", () => {
    const repoRoot = makeTempRepoWithCommit();
    const worktree = join(resolveTaskWorktreeConventionDirectory(repoRoot), "task-1");
    const currentOutput = currentWorkflowOutputPath(worktree);
    const v1_1Output = v1_1WorkflowOutputPath(worktree);
    mkdirSync(dirname(v1_1Output), { recursive: true });
    // A read-only file at the archived path fails the second call, after the first one succeeded.
    writeFileSync(v1_1Output, "blocked\n", { mode: 0o444 });

    try {
        assert.throws(() => buildWorkflowArguments(repoRoot, "true", [{ taskNumber: 1, files: ["seed.txt"] }]));
        assert.equal(existsSync(`${worktree}.lease`), false);
        assert.equal(existsSync(currentOutput), false, "the first call's successfully-written file must not survive");
        assert.equal(existsSync(v1_1Output), false);
    } finally {
        rmSync(worktree, { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// withTaskWorktreeLeaseGuard: the short-lived per-lease mutation guard.
// ---------------------------------------------------------------------------

test("withTaskWorktreeLeaseGuard makes one lease transition indivisible across two real processes", async () => {
    const repoRoot = makeTempRepoWithCommit();
    const worktreePath = join(repoRoot, "task-guarded");
    const logPath = join(repoRoot, "guard-log.txt");
    writeFileSync(logPath, "");
    const prepareTasksUrl = pathToFileURL(join(import.meta.dirname, "..", "scripts", "prepareTasks.ts")).href;
    const workerSource = `
      import { withTaskWorktreeLeaseGuard } from ${JSON.stringify(prepareTasksUrl)};
      import { appendFileSync } from "node:fs";
      withTaskWorktreeLeaseGuard(${JSON.stringify(worktreePath)}, () => {
        appendFileSync(${JSON.stringify(logPath)}, \`start:\${Date.now()}\\n\`);
        const wait = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(wait, 0, 0, 150);
        appendFileSync(${JSON.stringify(logPath)}, \`end:\${Date.now()}\\n\`);
      });
    `;
    const spawnWorker = () => spawn(process.execPath, ["--input-type=module", "--eval", workerSource], { stdio: ["ignore", "ignore", "ignore"] });
    const a = spawnWorker();
    const b = spawnWorker();
    try {
        await Promise.all([once(a, "exit"), once(b, "exit")]);
        const lines = readFileSync(logPath, "utf8").trim().split("\n");
        assert.equal(lines.length, 4);
        const events = lines.map((line) => {
            const [kind, time] = line.split(":");
            return { kind, time: Number(time) };
        });
        const [first, second, third, fourth] = events;
        assert.equal(first!.kind, "start");
        assert.equal(second!.kind, "end");
        assert.equal(third!.kind, "start");
        assert.equal(fourth!.kind, "end");
        // The second worker's guarded section never starts before the first worker's ends.
        assert.ok(third!.time >= second!.time);
        assert.equal(existsSync(taskWorktreeLeaseGuardPath(worktreePath)), false);
    } finally {
        rmSync(repoRoot, { recursive: true, force: true });
    }
});

test("acquireTaskWorktreeLease and releaseTaskWorktreeLease stay behaviorally identical to callers", () => {
    const repoRoot = makeTempRepoWithCommit();
    const worktreePath = join(repoRoot, "task-lease-behavior");
    mkdirSync(worktreePath, { recursive: true });
    try {
        const lease = acquireTaskWorktreeLease(worktreePath, "run-1");
        assert.deepEqual(lease, { worktreePath, runId: "run-1" });
        assert.throws(() => acquireTaskWorktreeLease(worktreePath, "run-2"), /already owned by a live run/);
        releaseTaskWorktreeLease(lease);
        assert.equal(existsSync(`${worktreePath}.lease`), false);
        // Idempotent: releasing an already-released lease is a no-op, not a throw.
        releaseTaskWorktreeLease(lease);
    } finally {
        rmSync(repoRoot, { recursive: true, force: true });
    }
});
