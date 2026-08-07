// Behavioral checks for prepareTasks.ts: brief writing, worktree creation, workflow args.  Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
    buildWorkflowArguments,
    createWorktreeForGroup,
    generateRunId,
    resolveMergeScriptPath,
    selectRequestedTasks,
    writeTaskBriefFile,
} from "../scripts/prepareTasks.ts";
import type { TaskGroup } from "../scripts/taskGroups.ts";

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

test("test_writeTaskBriefFileEmbedsTheDeclaredFileContents", () => {
    const repoRoot = makeTempRepoWithCommit();
    writeFileSync(join(repoRoot, "fileA.txt"), "MARKER-abc123\n");
    const task = { taskNumber: 1, title: "t1", description: "do the thing", files: ["fileA.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    assert.equal(briefFile, join(repoRoot, "plans", "brief-1.md"));
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /do the thing/);
    assert.match(text, /MARKER-abc123/);
});

test("test_writeTaskBriefFileOmitsMissingFilesWithoutThrowing", () => {
    const repoRoot = makeTempRepoWithCommit();
    const task = { taskNumber: 2, title: "t2", description: "desc", files: ["missing.txt"] };
    const briefFile = writeTaskBriefFile(task, repoRoot);
    const text = readFileSync(briefFile, "utf8");
    assert.match(text, /missing\.txt/);
    assert.match(text, /missing/i);
});

test("test_createWorktreeForGroupCreatesACheckoutOnItsOwnBranch", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    assert.equal(existsSync(worktreePath), true);
    const branch = git(worktreePath, "branch", "--show-current").trim();
    assert.equal(branch, "task-group-1");
});

test("test_createWorktreeForGroupReusesAnExistingWorktreeAtTheSamePath", () => {
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const first = createWorktreeForGroup(repoRoot, group);
    const second = createWorktreeForGroup(repoRoot, group);
    assert.equal(second, first);
});

test("test_createWorktreeForGroupRebasesAStaleWorktreeOntoTheSourceBranchTip", () => {
    // Setup: a worktree left behind by an earlier run, holding that run's commit.
    const repoRoot = makeTempRepoWithCommit();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    writeFileSync(join(worktreePath, "stale.txt"), "from the previous run\n");
    git(worktreePath, "add", "stale.txt");
    git(worktreePath, "commit", "-q", "-m", "previous run");
    // Setup: the source branch has since moved on.
    writeFileSync(join(repoRoot, "fresh.txt"), "landed since\n");
    git(repoRoot, "add", "fresh.txt");
    git(repoRoot, "commit", "-q", "-m", "fresh work");
    const sourceTip = git(repoRoot, "rev-parse", "HEAD").trim();
    // Test action: a second run hands a worker the same path.
    createWorktreeForGroup(repoRoot, group);
    // Verification: the worker gets the source branch tip, not the earlier run's codebase.
    assert.equal(git(worktreePath, "rev-parse", "HEAD").trim(), sourceTip);
    assert.equal(existsSync(join(worktreePath, "fresh.txt")), true);
    assert.equal(existsSync(join(worktreePath, "stale.txt")), false);
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
});

test("test_buildWorkflowArgumentsDictatesThePlanFilePathForEveryTask", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [268, 270], filePaths: ["a.ts"], scope: "declared" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const tasks = workflowArguments.groups[0].tasks;
    assert.match(tasks.find((t) => t.number === 268)!.planFile, /plans\/task-268-plan\.md$/);
    assert.match(tasks.find((t) => t.number === 270)!.planFile, /plans\/task-270-plan\.md$/);
});

test("test_buildWorkflowArgumentsProducesIdenticalOutputForIdenticalInput", () => {
    const repoRoot = makeTempRepoWithCommit();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const first = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const second = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("test_generateRunIdProducesDifferentValuesOnEachCall", () => {
    const first = generateRunId();
    const second = generateRunId();
    assert.equal(typeof first, "string");
    assert.ok(first.length > 0);
    assert.notEqual(first, second);
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
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [{ taskNum: 1, reason: "needs task 1" }], files: ["b.ts"] }];
    // Test action: select both requested tasks.
    const selected = selectRequestedTasks(openTasks, [1, 2]);
    // Verification: only the unblocked task survives, so no worktree is built for blocked work.
    assert.deepEqual(selected.map((t) => t.taskNumber), [1]);
});

test("test_selectRequestedTasksRefusesTasksWithNoFilesArray", () => {
    // Setup: task 1 declares files, task 2 has no files key at all; both are requested.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2 }];
    // Verification: the run stops and names only the undeclared task.
    assert.throws(() => selectRequestedTasks(openTasks, [1, 2]), /\b2\b/);
});

test("test_selectRequestedTasksTreatsAnEmptyFilesArrayAsUndeclared", () => {
    // Setup: task 1 carries an explicitly empty files array.
    const openTasks = [{ taskNumber: 1, files: [] }];
    // Verification: an empty array is refused like a missing one — no ownership fence.
    assert.throws(() => selectRequestedTasks(openTasks, [1]), /files/i);
});

test("test_selectRequestedTasksIgnoresMissingFilesOnABlockedTask", () => {
    // Setup: task 2 is blocked by open task 1 and declares no files; task 1 declares files.
    const openTasks = [{ taskNumber: 1, files: ["a.ts"] }, { taskNumber: 2, blockedBy: [{ taskNum: 1, reason: "needs task 1" }] }];
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
    // Verification: message names update-task-files, and its SKILL.md exists, so the pointer can't rot.
    assert.match(message, /update-task-files/);
    assert.ok(existsSync(join(import.meta.dirname, "..", "skills", "update-task-files", "SKILL.md")));
});

test("test_createWorktreeForGroupPutsSubmoduleOnTheGroupBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const group: TaskGroup = { groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" };
    const worktreePath = createWorktreeForGroup(repoRoot, group);
    const branch = git(join(worktreePath, "vendor"), "branch", "--show-current").trim();
    assert.equal(branch, "task-group-1");
});

test("test_buildWorkflowArgumentsRefusesADetachedSubmoduleWithoutCreatingAWorktreeDirectory", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    git(join(repoRoot, "vendor"), "checkout", "--detach", "HEAD");
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    assert.throws(() => buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups));
    assert.equal(existsSync(join(tmpdir(), "taskTools-wt", basename(repoRoot), "group-1")), false);
});

test("test_buildWorkflowArgumentsRecordsEachRepositorysSourceBranch", () => {
    const { repoRoot } = makeTempRepoWithLocalSubmodule();
    const groups: TaskGroup[] = [{ groupId: 1, taskNumbers: [1], filePaths: [], scope: "unknown" }];
    const workflowArguments = buildWorkflowArguments(repoRoot, "npx tsc --noEmit", groups);
    const paths = workflowArguments.repositorySources.map((source) => source.path);
    assert.ok(paths.includes(""));
    assert.ok(paths.includes("vendor"));
});
