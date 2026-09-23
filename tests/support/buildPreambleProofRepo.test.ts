// Real-git tests for buildPreambleProofRepo.ts: the four-task build and each of the four prepare cases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTaskWorktreeConventionDirectory } from "../../scripts/shared/prepareTasks.ts";
import { git } from "./gitFixtures.ts";

const SCRIPT_PATH = fileURLToPath(new URL("./buildPreambleProofRepo.ts", import.meta.url));

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function runScript(...args: string[]): string {
  return execFileSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: "utf8" }).trim();
}

function buildRepo(): string {
  const repoPath = runScript("build");
  temporaryDirectories.push(repoPath, resolveTaskWorktreeConventionDirectory(repoPath));
  return repoPath;
}

function readTasks(repoPath: string): Array<Record<string, any>> {
  return JSON.parse(readFileSync(join(repoPath, ".taskTools", "tasks.json"), "utf8"));
}

test("test_buildPreambleProofRepo_build_writesTheFourTaskFixture", () => {
  // Test action: build a fresh repo.
  const repoPath = buildRepo();

  // Verification: the repo is its own repository, with main and staging.
  assert.equal(git(repoPath, "rev-parse", "--show-toplevel"), realpathSync(repoPath));
  assert.equal(git(repoPath, "branch", "--show-current"), "main");
  assert.equal(git(repoPath, "rev-parse", "staging"), git(repoPath, "rev-parse", "main"));
  // Verification: a.txt to d.txt exist and e.txt does not.
  for (const file of ["a.txt", "b.txt", "c.txt", "d.txt"]) assert.equal(existsSync(join(repoPath, file)), true, file);
  assert.equal(existsSync(join(repoPath, "e.txt")), false);
  // Verification: four tasks, chained by blockedBy.
  const tasks = readTasks(repoPath);
  assert.deepEqual(tasks.map((task) => task.modifiableFiles), [["a.txt"], ["b.txt"], ["c.txt"], ["d.txt", "e.txt"]]);
  assert.equal("blockedBy" in tasks[0]!, false);
  for (const index of [1, 2, 3]) {
    assert.equal(tasks[index]!.blockedBy.length, 1);
    assert.equal(tasks[index]!.blockedBy[0].taskNumber, index);
    assert.notEqual(tasks[index]!.blockedBy[0].reason, "");
  }
});

test("test_buildPreambleProofRepo_prepare1_leavesStagingBehind", () => {
  // Setup: a fresh build.
  const repoPath = buildRepo();

  // Test action: set up case 1.
  assert.equal(runScript("prepare", "1", repoPath), repoPath);

  // Verification: main is one commit ahead of staging, and staging has nothing main lacks.
  assert.equal(git(repoPath, "rev-list", "--count", "staging..main"), "1");
  assert.equal(git(repoPath, "rev-list", "--count", "main..staging"), "0");
});

test("test_buildPreambleProofRepo_prepare2_leavesADivergedConflict", () => {
  // Setup: a fresh build.
  const repoPath = buildRepo();

  // Test action: set up case 2.
  runScript("prepare", "2", repoPath);

  // Verification: main and staging each hold one commit the other lacks, and merging them conflicts on z.txt.
  assert.equal(git(repoPath, "rev-list", "--count", "staging..main"), "1");
  assert.equal(git(repoPath, "rev-list", "--count", "main..staging"), "1");
  assert.equal(git(repoPath, "branch", "--show-current"), "main");
  const mergeBase = git(repoPath, "merge-base", "main", "staging");
  const mergeOutput = git(repoPath, "merge-tree", mergeBase, "main", "staging");
  assert.match(mergeOutput, /z\.txt/);
  assert.match(mergeOutput, /<<<<<<< \.our/);
});

test("test_buildPreambleProofRepo_prepare3_fakesAResumedWorktree", () => {
  // Setup: a fresh build.
  const repoPath = buildRepo();

  // Test action: set up case 3.
  runScript("prepare", "3", repoPath);

  // Verification: task 3's run names the worktree, one ended run with notes, and that run as lease owner.
  const run = readTasks(repoPath)[2]!.run;
  const expectedWorktree = join(resolveTaskWorktreeConventionDirectory(repoPath), "task-3");
  assert.equal(run.active, false);
  assert.equal(run.worktree, expectedWorktree);
  assert.equal(git(run.worktree, "branch", "--show-current"), "task-3");
  assert.equal(run.history.length, 1);
  assert.notEqual(run.history[0].endedAt, null);
  assert.equal(run.history[0].implementationNotesFile.startsWith(`${run.worktree}/`), true);
  assert.equal(existsSync(run.history[0].implementationNotesFile), true);
  assert.equal(run.leaseRunId, run.history[0].runId);
  // Verification: the lease file names the same run.
  assert.equal(JSON.parse(readFileSync(`${run.worktree}.lease`, "utf8")).runId, run.leaseRunId);
  // Verification: the worktree belongs to the fixture repo.
  assert.equal(git(run.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"), join(realpathSync(repoPath), ".git"));
  // Verification: the fence check's own diff sees stray.txt.
  assert.equal(git(run.worktree, "diff", "--name-only", "HEAD"), "stray.txt");
});

test("test_buildPreambleProofRepo_prepare4_leavesTheListedFileMissing", () => {
  // Setup: a fresh build.
  const repoPath = buildRepo();

  // Test action: set up case 4.
  runScript("prepare", "4", repoPath);

  // Verification: e.txt is still missing, and task 4 still lists it.
  assert.equal(existsSync(join(repoPath, "e.txt")), false);
  assert.equal(git(repoPath, "ls-files", "e.txt"), "");
  assert.deepEqual(readTasks(repoPath)[3]!.modifiableFiles, ["d.txt", "e.txt"]);
});
