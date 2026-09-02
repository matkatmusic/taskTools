import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/tackle-tasks_BootstrapAgentPromptEmitter.ts", import.meta.url));
const DRIVER_RESULT_PREFIX = "Return exactly this JSON as your structured result, with no other keys added or removed:\n";

function git(repoRoot: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "bootstrap-emitter-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "remote", "add", "origin", "https://example.com/root.git");
  mkdirSync(join(root, ".taskTools"), { recursive: true });
  writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([
    { taskNumber: 1, title: "open blocker", files: ["a.txt"] },
    { taskNumber: 2, title: "blocked by open task", files: ["b.txt"], blockedBy: [{ taskNumber: 1, reason: "needs task 1" }] },
  ]));
  writeFileSync(join(root, ".taskTools", "completedTasks.json"), JSON.stringify([{ taskNumber: 3, title: "already done" }]));
  writeFileSync(join(root, "a.txt"), "a\n");
  writeFileSync(join(root, "b.txt"), "b\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  return root;
}

function runEmitter(cwd: string, mode: string, argsValue: string): unknown {
  const output = execFileSync("node", [scriptPath, mode], { cwd, input: argsValue, encoding: "utf8" });
  assert.ok(output.startsWith(DRIVER_RESULT_PREFIX), `unexpected output: ${output}`);
  return JSON.parse(output.slice(DRIVER_RESULT_PREFIX.length).trim());
}

test("discover mode returns schema-valid blockerPairs and unblockedNumbers, never raw text", () => {
  const root = makeFixtureRepo();
  try {
    const result = runEmitter(root, "discover", "[1,2]") as { blockerPairs: unknown[]; unblockedNumbers: number[] };
    assert.deepEqual(result.blockerPairs, [{ blockedTask: 2, blockerTask: 1, reason: "needs task 1" }]);
    assert.deepEqual(result.unblockedNumbers, [1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare mode returns normalized taskDetails, parsed pipelineArgs, and maxConcurrency", () => {
  const root = makeFixtureRepo();
  try {
    const result = runEmitter(root, "prepare", "[1,2]") as {
      taskDetails: Array<{ number: number; status: string; task: unknown }>;
      pipelineArgs: { repo: string; groups: Array<{ tasks: Array<{ number: number }> }> };
      maxConcurrency: number;
    };
    assert.equal(result.taskDetails.length, 1);
    assert.equal(result.taskDetails[0]!.number, 1);
    assert.equal(result.taskDetails[0]!.status, "open");
    assert.equal(typeof result.pipelineArgs, "object");
    assert.ok(result.pipelineArgs.repo.endsWith(root.replace(/^\/private/, "")));
    assert.equal(result.pipelineArgs.groups[0]!.tasks[0]!.number, 1);
    assert.equal(typeof result.maxConcurrency, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discover mode treats a nonexistent task number as unblocked, matching checkBlockers.ts's pre-existing behavior", () => {
  const root = makeFixtureRepo();
  try {
    const result = runEmitter(root, "discover", "[1,999]") as { unblockedNumbers: number[] };
    assert.deepEqual(result.unblockedNumbers, [1, 999]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare mode returns completed/not-found taskDetails instead of aborting, and creates no worktree for them", () => {
  const root = makeFixtureRepo();
  try {
    const result = runEmitter(root, "prepare", "[3,999]") as {
      taskDetails: Array<{ number: number; status: string; task: unknown }>;
      pipelineArgs: { groups: unknown[] };
    };
    assert.deepEqual(result.taskDetails, [
      { number: 3, status: "completed", task: { taskNumber: 3, title: "already done" } },
      { number: 999, status: "not-found", task: null },
    ]);
    assert.deepEqual(result.pipelineArgs.groups, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare mode with a mixed open/completed/not-found request only prepares the open task", () => {
  const root = makeFixtureRepo();
  try {
    const result = runEmitter(root, "prepare", "[1,3,999]") as {
      taskDetails: Array<{ number: number; status: string; task: unknown }>;
      pipelineArgs: { groups: Array<{ tasks: Array<{ number: number }> }> };
    };
    assert.deepEqual(
      result.taskDetails.map((d) => [d.number, d.status]),
      [[1, "open"], [3, "completed"], [999, "not-found"]],
    );
    assert.equal(result.pipelineArgs.groups.length, 1);
    assert.equal(result.pipelineArgs.groups[0]!.tasks[0]!.number, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails loudly on an unknown mode or missing arguments", () => {
  const root = makeFixtureRepo();
  try {
    assert.throws(() => execFileSync("node", [scriptPath, "bogus"], { cwd: root, input: "[1]", encoding: "utf8", stdio: "pipe" }));
    assert.throws(() => execFileSync("node", [scriptPath, "discover"], { cwd: root, input: "", encoding: "utf8", stdio: "pipe" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
