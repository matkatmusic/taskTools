import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { compileFunction, constants as vmConstants } from "node:vm";
import { tackleTasksBrief } from "../scripts/tackleTasksBrief.ts";
import { TASKS_PER_COMMAND } from "../scripts/taskStats.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { consumeTaskWorkflowResult, createMergeQueue } from "../scripts/runMergePhase.ts";

const scriptPath = fileURLToPath(new URL("../scripts/tackleTasksBrief.ts", import.meta.url));
const checkBlockersPath = fileURLToPath(new URL("../scripts/checkBlockers.ts", import.meta.url));

test("brief leaves no unexpanded CLAUDE_PLUGIN_ROOT or $ARGUMENTS placeholder", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
  assert.doesNotMatch(brief, /\$ARGUMENTS/);
});

test("RETIRED (task 163) marker keeps its commented paragraph body, not a bare tombstone", () => {
  const source = readFileSync(scriptPath, "utf8");
  const markerIndex = source.indexOf("// RETIRED (task 163):");
  assert.notEqual(markerIndex, -1);
  const afterMarker = source.slice(markerIndex, markerIndex + 1000);
  const bodyLines = afterMarker.split("\n").slice(1, 5);
  assert.ok(bodyLines.every((line) => line === "" || line.startsWith("//")));
  assert.match(afterMarker, /one \\`close-tasks\\` skill call/);
  assert.match(afterMarker, /Orchestrator ran typecheck only/);
});

test("script reads arguments from stdin and embeds the live checkBlockers.ts output", () => {
  const argsValue = "[75] valid";
  const expectedStatus = execFileSync("node", [checkBlockersPath, argsValue], { encoding: "utf8" }).trimEnd();
  const output = execFileSync("node", [scriptPath], { input: `${argsValue}\n`, encoding: "utf8" });
  assert.ok(output.startsWith(`- blocked status: ${expectedStatus}\n`));
});

test("series adds the serial-mode section and leaves the brief untouched without it", () => {
  const parallel = tackleTasksBrief("[131,132] valid", "task 131: unblocked");
  const serial = tackleTasksBrief("[131,132] valid series", "task 131: unblocked");
  assert.doesNotMatch(parallel, /Serial mode/);
  assert.match(serial, /## Serial mode/);
  const withoutSection = serial.replace(/\n## Serial mode[\s\S]*?not per task\.\n/, "");
  assert.equal(withoutSection.replaceAll(" series", ""), parallel);
});

test("script fails loudly rather than emitting a brief that points nowhere", () => {
  assert.throws(() => execFileSync("node", [scriptPath], { input: "", encoding: "utf8", stdio: "pipe" }));
});

test("running the pipeline launches task.workflow.js once per task in the background, with no phase barriers", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /Launch `.*task\.workflow\.js` once per entry in `groups`, as a \*\*background\*\*/);
  assert.match(brief, /Args for each launch: `\{task, typecheckCommand, worktree, sourceRoot\}`/);
  assert.match(brief, /task-notification back to you/);
  assert.doesNotMatch(brief, /wait for each to finish before starting/);
  assert.doesNotMatch(brief, /stepOutputsFile/);
  assert.doesNotMatch(brief, /mergeCommand/);
  assert.doesNotMatch(brief, /Step 1 — plan/);
  assert.match(brief, new RegExp(`Keep up to ${TASKS_PER_COMMAND} task\\.workflow\\.js runs in flight`));
  assert.match(brief, /sliding window, not\s+batches of/);
});

test("initial and tail launch args both name sourceRoot as the pipeline args repo value", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /`sourceRoot` is the top-level pipeline args `repo` value/);
  assert.match(brief, /"sourceRoot": "\/path\/to\/repo"/);
});

test("gate: each finished task is presented as one AskUserQuestion gate, never batched", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /## Gate each task/);
  assert.match(brief, /Call `AskUserQuestion` once for that task/);
  assert.match(brief, /"Approve for merge"/);
  assert.match(brief, /"Do not approve"/);
  assert.match(brief, /fence\s+violations the implement stage recorded for it\s+\(task 138\)/);
  assert.match(brief, /codex\s+objections that survived that task's\s+plan-review rounds \(task 135\)/);
  assert.match(brief, /Present each fence violation and each\s+surviving objection as its own proposed task/);
  assert.match(brief, /invoke the `create-task`\s+skill once, never edit\s+`tasks\.json` directly\./);
  assert.match(brief, /Do not wait for any other\s+task's workflow to finish/);
  assert.match(brief, /the task never enters the merge queue and never merges\./);
  assert.match(brief, /enters the merge queue\s+immediately on approval/);
  assert.match(brief, /never let this gate become a\s+barrier that waits for the whole batch\./);
});

test("merge queue: an approved task launches rebase-test then merge, and the brief never mentions the close-tasks skill", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /## Merge queue/);
  assert.match(brief, /node --input-type=module <<'TASK_TOOLS_QUEUE'/);
  assert.doesNotMatch(brief, /node -e "/);
  assert.match(brief, /createMergeQueue/);
  assert.match(brief, /enqueueApprovedTask\(queue, taskNumber\)/);
  assert.match(brief, /nextQueueAction\(queue, outstanding\)/);
  assert.match(brief, /Launch `.*task\.workflow\.js` as a background workflow with args `\{task: taskNumber, stage, typecheckCommand, repositoryManifest, worktree, sourceRoot\}`/);
  assert.match(brief, /rebase-test or merge workflow is still outstanding/s);
  assert.match(brief, /`FN` = `consumeTaskWorkflowResult`/);
  assert.doesNotMatch(brief, /results\[[01]\]/);
  assert.match(brief, /buildMergeReport\(queue\)/);
  assert.match(brief, /outstandingEntries/);
  assert.match(brief, /immediately ask that task's own approval gate/);
  assert.match(brief, /`"launch"`:.*Launch `.*task\.workflow\.js`/s);
  assert.doesNotMatch(brief, /close-tasks/);
});

test("merge queue: the next-lap branch waits for an outstanding workflow instead of starting another lap against the same tip", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /`"begin-next-lap"`: run `beginNextLap\(queue\)`/s);
  assert.match(brief, /`"wait"`: a rebase-test or merge workflow is still outstanding, or nothing is ready to launch and the lap can't roll yet\./s);
});

test("the superseded workflow files are deleted and nothing outside plans/ or .taskTools/ imports them", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const superseded = [
    "skills/tackle-tasks/merge.workflow.js",
    "skills/tackle-tasks/plan.workflow.js",
    "skills/tackle-tasks/implement.workflow.js",
    "skills/tackle-tasks/test.workflow.js",
    "skills/tackle-tasks/verify.workflow.js",
  ];
  for (const relativePath of superseded) {
    assert.equal(existsSync(join(repoRoot, relativePath)), false, `${relativePath} should have been deleted`);
  }
  let matches = "";
  try {
    matches = execFileSync(
      "git",
      ["grep", "-l", "-e", "merge.workflow.js", "-e", "plan.workflow.js", "-e", "implement.workflow.js", "-e", "test.workflow.js", "-e", "verify.workflow.js", "--", ".", ":!plans", ":!.taskTools", ":!tests/tackleTasksBrief.test.ts"],
      { encoding: "utf8", cwd: repoRoot },
    );
  } catch (error) {
    const failure = error as { status?: number };
    if (failure.status !== 1) throw error;
  }
  assert.equal(matches.trim(), "");
});

const REPO_ROOT_FOR_WORKFLOW = fileURLToPath(new URL("..", import.meta.url));
const TASK_WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT_FOR_WORKFLOW, "skills/tackle-tasks/task.workflow.js"), "utf8")
  .replace("export const meta", "const meta");

type TaskWorkflowResult = { task: number; stage: "plan+implement" | "rebase-test" | "merge"; results: Array<Record<string, unknown>> };
type TaskWorkflowRunner = (argsJson: string, log: (...values: unknown[]) => void, agent: (...values: unknown[]) => Promise<unknown>) => Promise<TaskWorkflowResult>;

// ponytail: duplicated from tests/runMergePhase.test.ts rather than importing a .test.ts module,
// which would re-register that file's own tests under this file's run. Extract to a shared
// helper module if a third caller needs the same fixture.
const runTaskWorkflowStage = async (worktreePath: string, args: Record<string, unknown>, agent: (...values: unknown[]) => Promise<unknown>) => {
  const fn = compileFunction(
    `return (async () => { 'use strict'\n${TASK_WORKFLOW_SOURCE} })()`,
    ["args", "log", "agent"],
    { filename: join(REPO_ROOT_FOR_WORKFLOW, "skills/tackle-tasks/task.workflow.js"), importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  ) as TaskWorkflowRunner;
  return await fn(JSON.stringify({ worktree: worktreePath, ...args }), () => {}, agent);
};

const gitForWorkflowFixture = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const makeWorkflowFixtureRepo = (taskNumber: number) => {
  const root = mkdtempSync(join(tmpdir(), "tackle-tasks-brief-fixture-root-"));
  gitForWorkflowFixture(root, "init", "-q", "-b", "main");
  gitForWorkflowFixture(root, "config", "user.email", "test@example.com");
  gitForWorkflowFixture(root, "config", "user.name", "Test");
  gitForWorkflowFixture(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "root\n");
  gitForWorkflowFixture(root, "add", "README.md");
  gitForWorkflowFixture(root, "commit", "-q", "-m", "init");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  gitForWorkflowFixture(root, "add", "package.json");
  gitForWorkflowFixture(root, "commit", "-q", "-m", "add test script");
  const sourceBranch = "main";
  const baseOid = gitForWorkflowFixture(root, "rev-parse", sourceBranch);
  const operationBranch = `task-${taskNumber}`;
  const worktreePath = join(tmpdir(), `tackle-tasks-brief-fixture-wt-${randomUUID()}`);
  gitForWorkflowFixture(root, "worktree", "add", "-q", "-b", operationBranch, worktreePath, sourceBranch);
  mkdirSync(join(worktreePath, "plans"), { recursive: true });
  symlinkSync(join(REPO_ROOT_FOR_WORKFLOW, "scripts"), join(worktreePath, "scripts"));
  mkdirSync(join(root, ".taskTools"), { recursive: true });
  const taskRecord = { taskNumber, title: "fixture", files: [], blockedBy: [] };
  writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([taskRecord]));
  writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");
  mkdirSync(join(worktreePath, ".taskTools"), { recursive: true });
  writeFileSync(join(worktreePath, ".taskTools", "tasks.json"), JSON.stringify([taskRecord]));
  const repositoryManifest: RepositoryManifest = {
    version: REPOSITORY_MANIFEST_VERSION,
    occurrences: [{
      occurrenceId: "",
      checkoutPath: root,
      parentOccurrenceId: null,
      pathInParent: null,
      gitlinkOid: null,
      depth: 0,
      originUrl: "",
      baseBranch: sourceBranch,
      baseOid,
      operationBranch,
      childOccurrenceIds: [],
      testState: "untested",
    }],
  };
  return { root, worktreePath, repositoryManifest };
};

const throwingAgentForWorkflowFixture = async () => { throw new Error("this stage must not call an agent"); };

test("generated brief's results[] references match a real, non-synthetic task.workflow.js envelope for rebase-test and merge", async () => {
  const taskNumber = 9171;
  const { root, worktreePath, repositoryManifest } = makeWorkflowFixtureRepo(taskNumber);
  try {
    writeFileSync(join(worktreePath, "taskfile.txt"), "task change\n");
    gitForWorkflowFixture(worktreePath, "add", "taskfile.txt");
    gitForWorkflowFixture(worktreePath, "commit", "-q", "-m", "task change");

    const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest, sourceRoot: root }, throwingAgentForWorkflowFixture);
    const rebaseTestOutcome = rebaseTestResult.results[0] as { status: string };
    assert.equal((rebaseTestResult as unknown as { status?: string }).status, undefined);
    assert.equal(typeof rebaseTestOutcome.status, "string");

    const mergeResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "merge", repositoryManifest, sourceRoot: root }, throwingAgentForWorkflowFixture);
    const mergeOutcome = mergeResult.results[0] as { status: string; mergedCommitHash?: string };
    assert.equal((mergeResult as unknown as { status?: string }).status, undefined);
    assert.equal(typeof mergeOutcome.status, "string");
    assert.equal(typeof mergeOutcome.mergedCommitHash, "string");
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated brief's plan+implement handling matches a real, non-synthetic workflow envelope through consumeTaskWorkflowResult, and the brief text never indexes results[]", async () => {
  const taskNumber = 9172;
  const { root, worktreePath, repositoryManifest } = makeWorkflowFixtureRepo(taskNumber);
  const fakeAgent = async (_briefText: unknown, optionsValue: unknown) => {
    const options = optionsValue as { label: string };
    if (options.label.startsWith("plan:")) {
      const planFile = join(worktreePath, `plans/task-${taskNumber}-plan.md`);
      mkdirSync(join(worktreePath, "plans"), { recursive: true });
      writeFileSync(planFile, "plan\n");
      return { task: taskNumber, status: "planned", planFile, question: "" };
    }
    if (options.label.startsWith("verify:")) return { task: taskNumber, verdict: "approved", notes: "looks good", reviewer: "codex", missingFiles: [] };
    if (options.label.startsWith("implement:")) {
      const notesFile = join(worktreePath, `plans/task-${taskNumber}-implementation-notes.md`);
      writeFileSync(notesFile, "notes\n");
      gitForWorkflowFixture(worktreePath, "add", `plans/task-${taskNumber}-implementation-notes.md`);
      gitForWorkflowFixture(worktreePath, "commit", "-q", "-m", `task ${taskNumber}: implement`);
      return { task: taskNumber, status: "done", summary: "did it", remaining: [], notesFile };
    }
    throw new Error(`unexpected agent label ${options.label}`);
  };
  try {
    const result = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "plan+implement", repositoryManifest, sourceRoot: root }, fakeAgent);
    const consumed = consumeTaskWorkflowResult(createMergeQueue(), result);
    assert.equal(consumed.kind, "approval");
    if (consumed.kind !== "approval") return assert.fail("expected approval result");
    assert.equal(consumed.approval.status, "done");
    assert.equal((consumed.approval.verifier as { verdict?: string } | null)?.verdict, "approved");
    assert.ok(Array.isArray(consumed.approval.fenceViolations));

    const brief = tackleTasksBrief("[1]", "task 1: unblocked");
    assert.match(brief, /consumeTaskWorkflowResult/);
    assert.match(brief, /consumed\.approval\.status/);
    assert.match(brief, /consumed\.approval\.fenceViolations/);
    assert.match(brief, /consumed\.approval\.verifier/);
    assert.doesNotMatch(brief, /results\[[01]\]/);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
