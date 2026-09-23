// Builds a four-task proof repo; `build`, or `prepare <1-4> <repoPath>` for one preamble stop.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTaskWorktreeConventionDirectory } from "../../scripts/shared/prepareTasks.ts";
import { ensureStagingWorktree, stagingWorktreePath } from "../../scripts/tackle-tasks/shared/stagingWorktree.ts";
import { git, makeCommittedRepo } from "./gitFixtures.ts";

const TASK_FILES = ["a.txt", "b.txt", "c.txt", "d.txt"];

// Same fields as the task in tests/tackleTasksAcceptance.test.ts; createsFiles stays empty so task 4's e.txt counts as missing.
function proofTask(taskNumber: number, modifiableFiles: string[]): Record<string, unknown> {
  const instruction = `Add the line "task ${taskNumber}" to the end of each file in modifiableFiles.`;
  return {
    taskNumber,
    title: `Proof task ${taskNumber}`,
    userDescription: instruction,
    description: instruction,
    modifiableFiles,
    createsFiles: [],
    readOnlyFiles: ["*"],
    goal: "",
    notInScope: "",
    hasTests: false,
    difficulty: 1,
    schemaVersion: "1.0.1",
  };
}

const PROOF_TASKS = [
  proofTask(1, ["a.txt"]),
  { ...proofTask(2, ["b.txt"]), blockedBy: [{ taskNumber: 1, reason: "proof order: task 1 runs first" }] },
  { ...proofTask(3, ["c.txt"]), blockedBy: [{ taskNumber: 2, reason: "proof order: task 2 runs first" }] },
  { ...proofTask(4, ["d.txt", "e.txt"]), blockedBy: [{ taskNumber: 3, reason: "proof order: task 3 runs first" }] },
];

function tasksPath(repoPath: string): string {
  return join(repoPath, ".taskTools", "tasks.json");
}

// Like the acceptance fixture: package.json for the task-test step, and .taskTools left uncommitted.
function build(): string {
  const repoPath = makeCommittedRepo("preamble-proof-", "main");
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "preamble-proof", private: true, scripts: { test: "node --test" } }));
  for (const file of TASK_FILES)
    writeFileSync(join(repoPath, file), `${file}\n`);
  git(repoPath, "add", "package.json", ...TASK_FILES);
  git(repoPath, "commit", "-q", "-m", "proof task files");
  git(repoPath, "branch", "staging");
  mkdirSync(join(repoPath, ".taskTools"));
  writeFileSync(tasksPath(repoPath), JSON.stringify(PROOF_TASKS, null, 2));
  writeFileSync(join(repoPath, ".taskTools", "completedTasks.json"), "[]");
  return repoPath;
}

// Case 1: main moves on, so staging is behind.
function prepareStagingBehind(repoPath: string): void {
  writeFileSync(join(repoPath, "main-only.txt"), "main moved\n");
  git(repoPath, "add", "main-only.txt");
  git(repoPath, "commit", "-q", "-m", "main moves past staging");
}

// Case 2: main and staging each add z.txt with a different line, so the catch-up merge conflicts.  Staging's commit lands in the awaitingTesting worktree, since a real run leaves it checked out there.
function prepareCatchUpConflict(repoPath: string): void {
  // Runs before main diverges, so this is a no-op when the caller already set the worktree up.
  ensureStagingWorktree(repoPath, "staging");
  writeFileSync(join(repoPath, "z.txt"), "main line\n");
  git(repoPath, "add", "z.txt");
  git(repoPath, "commit", "-q", "-m", "main writes z.txt");
  // RETIRED: git(repoPath, "checkout", "-q", "staging");
  const stagingWorktree = stagingWorktreePath(repoPath);
  writeFileSync(join(stagingWorktree, "z.txt"), "staging line\n");
  git(stagingWorktree, "add", "z.txt");
  git(stagingWorktree, "commit", "-q", "-m", "staging writes z.txt");
  // RETIRED: git(repoPath, "checkout", "-q", "main");
}

// Case 3: an interrupted run's task-3 worktree, lease, ended run, notes file, and stray edit.
function prepareResumedWorktree(repoPath: string): void {
  const worktree = join(resolveTaskWorktreeConventionDirectory(repoPath), "task-3");
  git(repoPath, "worktree", "add", "-q", "-b", "task-3", worktree, "staging");
  const notesFile = join(worktree, "plans", "implementation-notes-3.md");
  mkdirSync(join(worktree, "plans"));
  writeFileSync(notesFile, "# task 3 notes\n");
  writeFileSync(join(worktree, "stray.txt"), "stray edit\n");
  // Staged, because the fence check reads `git diff HEAD`, which skips untracked files.
  git(worktree, "add", "stray.txt");
  const runId = "20260101-000000.000";
  writeFileSync(`${worktree}.lease`, JSON.stringify({ runId }));
  const tasks = JSON.parse(readFileSync(tasksPath(repoPath), "utf8")) as Array<Record<string, unknown>>;
  const task3 = tasks.find((task) => task.taskNumber === 3)!;
  task3.run = {
    active: false,
    worktree,
    leaseRunId: runId,
    history: [{
      runId,
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:10:00.000Z",
      exitType: "run-failed",
      exitNote: "interrupted",
      modifiedFiles: [],
      commits: [],
      implementationNotesFile: notesFile,
      taskTests: null,
      fullSuite: null,
    }],
  };
  writeFileSync(tasksPath(repoPath), JSON.stringify(tasks, null, 2));
}

// Case 4 needs no change: build leaves task 4's e.txt missing.
const PREPARE_BY_CASE: Record<string, (repoPath: string) => void> = {
  "1": prepareStagingBehind,
  "2": prepareCatchUpConflict,
  "3": prepareResumedWorktree,
  "4": () => {},
};

const [command, caseNumber, repoPath] = process.argv.slice(2);
if (command === "build") {
  console.log(build());
} else if (command === "prepare") {
  PREPARE_BY_CASE[caseNumber!]!(repoPath!);
  console.log(repoPath);
} else {
  throw new Error(`usage: build | prepare <1-4> <repoPath>; got "${process.argv.slice(2).join(" ")}"`);
}
