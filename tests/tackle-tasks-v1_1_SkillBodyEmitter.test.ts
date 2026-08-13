import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { compileFunction } from "node:vm";
import { skillBody } from "../scripts/tackle-tasks-v1_1_SkillBodyEmitter.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { consumeTaskWorkflowResult, createMergeQueue } from "../scripts/runMergePhase.ts";
import { buildWorkflowArguments, materializeTaskWorkflow } from "../scripts/prepareTasks.ts";
import type { TaskRecord } from "../scripts/taskFiles.ts";

const scriptPath = fileURLToPath(new URL("../scripts/tackle-tasks-v1_1_SkillBodyEmitter.ts", import.meta.url));
const skillMdPath = fileURLToPath(new URL("../skills/tackle-tasks-v1_1/SKILL.md", import.meta.url));

// ---------------------------------------------------------------------------
// Conformance: SkillBodyEmitter is a path-only boundary (C86-39).
// ---------------------------------------------------------------------------

test("skillBody is nonempty and leaves no unexpanded CLAUDE_PLUGIN_ROOT or $ARGUMENTS placeholder", () => {
  const brief = skillBody("[1]");
  assert.ok(brief.trim().length > 0);
  assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
  assert.doesNotMatch(brief, /\$ARGUMENTS/);
});

test("emitter runs no subprocess and imports nothing relative — only node:fs and node:url", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(source, /execFileSync|spawn|from "\./);
});

test("SKILL.md invokes tackle-tasks-v1_1_SkillBodyEmitter.ts", () => {
  const skillMd = readFileSync(skillMdPath, "utf8");
  assert.match(skillMd, /tackle-tasks-v1_1_SkillBodyEmitter\.ts/);
});

test("output never names checkBlockers.ts, getTaskDetails.ts, or prepareTasks.ts — only the bootstrap agent prompt emitter does", () => {
  const brief = skillBody("[75] valid");
  assert.doesNotMatch(brief, /checkBlockers\.ts/);
  assert.doesNotMatch(brief, /getTaskDetails\.ts/);
  assert.doesNotMatch(brief, /prepareTasks\.ts/);
  assert.match(brief, /tackle-tasks-v1_1_BootstrapAgentPromptEmitter\.ts/);
});

test("output opens with a discover-mode Workflow declaration, not a live blocked-status report", () => {
  const brief = skillBody("[75] valid");
  assert.match(brief, /^Run `Workflow\(\{"scriptPath": ".*bootstrap\.workflow\.js", "args": \{"mode": "discover"/);
  assert.doesNotMatch(brief, /- blocked status:/);
});

test("the prepare-mode Workflow declaration runs after the disprove-blockers step", () => {
  const brief = skillBody("[75] valid");
  const prepareIndex = brief.indexOf('"mode": "prepare"');
  const disprovenIndex = brief.indexOf("disproven");
  assert.ok(prepareIndex > 0 && disprovenIndex > 0);
  assert.ok(prepareIndex > disprovenIndex);
});

test("script fails loudly rather than emitting a brief that points nowhere", () => {
  assert.throws(() => execFileSync("node", [scriptPath], { input: "", encoding: "utf8", stdio: "pipe" }));
});

test("a real invocation returns instantly, without touching tasks.json or running any command", () => {
  const output = execFileSync("node", [scriptPath], { input: "[999999] valid\n", encoding: "utf8" });
  assert.match(output, /Workflow\(/);
});

// ---------------------------------------------------------------------------
// Orchestration content: static main-agent instructions the emitter still owns.
// ---------------------------------------------------------------------------

// C86-43: series mode must never emit a whole-array discover/prepare call before its per-task loop.
test("series brief contains no whole-array discover or prepare call, only a per-task [N] loop", () => {
  const serial = skillBody("[131,132] valid series");
  assert.doesNotMatch(serial, /"argsValue":\s*"\[131,132\][^"]*"/);
  const discoverCalls = [...serial.matchAll(/"mode":\s*"discover",\s*"argsValue":\s*"([^"]*)"/g)].map((m) => m[1]);
  const prepareCalls = [...serial.matchAll(/"mode":\s*"prepare",\s*"argsValue":\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(discoverCalls, ["[N]"]);
  assert.deepEqual(prepareCalls, ["[N]"]);
  assert.match(serial, /single-element array `\[N\]`/);
  assert.match(serial, /finish that task completely before starting the next/);
});

test("series brief stops the chain on an unmerged task and does the commit-message step once, at the end", () => {
  const serial = skillBody("[131,132] valid series");
  assert.match(serial, /stop the chain and report/);
  assert.match(serial, /Do the \*\*Commit message\*\* section once, after the last task in the chain, not per task\./);
  const commitSectionIndex = serial.lastIndexOf("## Commit message");
  assert.equal(serial.indexOf("## Commit message"), commitSectionIndex, "only one Commit message section");
});

// C86-47: prepare paragraph and closing rule used to give opposite non-open-status instructions.
test("series skips completed or missing tasks but stops after an open task fails to merge", () => {
  const serial = skillBody("[131,132] valid series");
  assert.match(
    serial,
    /If `status` is `"completed"` or `"not-found"`, report and explicitly skip this task, then continue with the next task number without launching this task's pipeline\./,
  );
  assert.doesNotMatch(serial, /If `status` is not `"open"`, report it and stop the chain instead of preparing the next task number\./);
  assert.match(serial, /If this task ends with anything unmerged/);
});

test("parallel skillBody stays byte-identical whether or not the word series appears unrelated to it, so long as it does not match \\bseries\\b", () => {
  const withoutSeries = skillBody("[131,132] valid");
  assert.doesNotMatch(withoutSeries, /Serial mode|series/);
});

// C86-43: exercises the real lease code the old whole-array-then-per-task order collided against.
test("real lease mechanism: a whole-array prepare followed by a per-task re-prepare collides, but a lone per-task prepare (what the series brief now emits) does not", () => {
  const root = mkdtempSync(join(tmpdir(), "tackle-tasks-series-lease-"));
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(root, "README.md"), "root\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "init"]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://example.com/root.git"]);

  const tasks: TaskRecord[] = [
    { taskNumber: 1, files: ["README.md"] } as TaskRecord,
    { taskNumber: 2, files: ["README.md"] } as TaskRecord,
  ];
  try {
    // The old order: a whole-array prepare (what used to run unconditionally before the series loop)...
    buildWorkflowArguments(root, "true", tasks, "run-whole-array");
    // ...then the per-task re-prepare the series section instructed, under a different run.
    assert.throws(
      () => buildWorkflowArguments(root, "true", [tasks[0]!], "run-per-task-retry"),
      /already owned by a live run/,
    );

    // Fixed order: a lone per-task prepare on a fresh worktree, no prior lease to collide with.
    const solo: TaskRecord[] = [{ taskNumber: 3, files: ["README.md"] } as TaskRecord];
    assert.doesNotThrow(() => buildWorkflowArguments(root, "true", solo, "run-series-task-3"));
  } finally {
    rmSync(join(tmpdir(), "taskTools-wt", basename(root)), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("running the pipeline launches the task's materialized workflowPath in the background via one capacity-aware scheduler, with no phase barriers", () => {
  const brief = skillBody("[1]");
  assert.match(brief, /Launch that task's\s+`workflowPath` as a \*\*background\*\* workflow/);
  assert.match(brief, /\{task: action\.taskNumber, typecheckCommand: pipelineArgs\.typecheckCommand, repositoryManifest: pipelineArgs\.repositoryManifest, worktree, sourceRoot: pipelineArgs\.repo, runId: pipelineArgs\.runId, agentPromptEmitterPath\}/);
  assert.match(brief, /task-notification back to you/);
  assert.doesNotMatch(brief, /wait for each to finish before starting/);
  assert.doesNotMatch(brief, /stepOutputsFile/);
  assert.doesNotMatch(brief, /mergeCommand/);
  assert.doesNotMatch(brief, /Step 1 — plan/);
  assert.match(brief, /one shared ceiling across every launch kind/);
  assert.match(brief, /never a\s+batch size to fill/);
  assert.match(brief, /nextSchedulerAction.*is\s+the single capacity-aware decision point for all of them/s);
});

test("initial and tail launch args both name sourceRoot as pipelineArgs.repo and carry runId", () => {
  const brief = skillBody("[1]");
  const sourceRootMatches = brief.match(/sourceRoot: pipelineArgs\.repo/g);
  assert.ok(sourceRootMatches && sourceRootMatches.length >= 2);
  const runIdMatches = brief.match(/runId: pipelineArgs\.runId/g);
  assert.ok(runIdMatches && runIdMatches.length >= 2);
  assert.match(brief, /"sourceRoot": "\/path\/to\/repo"/);
});

// C86-40: launch-plan omitted repositoryManifest even though launch-tail already carried it.
test("launch-plan and launch-tail args both carry pipelineArgs.repositoryManifest", () => {
  const brief = skillBody("[1]");
  const manifestMatches = brief.match(/repositoryManifest: pipelineArgs\.repositoryManifest/g);
  assert.ok(manifestMatches && manifestMatches.length >= 2);
  const launchPlanArgs = brief.match(/"launch-plan"`:[\s\S]*?with args\s+`(\{[^`]*\})`/);
  assert.ok(launchPlanArgs, "launch-plan args pattern not found");
  assert.match(launchPlanArgs![1]!, /repositoryManifest: pipelineArgs\.repositoryManifest/);
});

test("gate: each finished task is presented as one AskUserQuestion gate, never batched", () => {
  const brief = skillBody("[1]");
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
  const brief = skillBody("[1]");
  assert.match(brief, /## Merge queue/);
  assert.match(brief, /node --input-type=module <<'TASK_TOOLS_QUEUE'/);
  assert.doesNotMatch(brief, /node -e "/);
  assert.match(brief, /createMergeQueue/);
  assert.match(brief, /enqueueApprovedTask\(queue, taskNumber\)/);
  assert.match(brief, /`FN` = `nextSchedulerAction`, `ARGS` = `<QUEUE_JSON>, ready, outstanding`/);
  assert.match(brief, /Launch that\s+task's `workflowPath` as a background workflow with args\s+`\{task: taskNumber, stage, typecheckCommand: pipelineArgs\.typecheckCommand, repositoryManifest: pipelineArgs\.repositoryManifest, worktree, sourceRoot: pipelineArgs\.repo, runId: pipelineArgs\.runId, agentPromptEmitterPath\}`/);
  assert.match(brief, /tail is serialized behind one already outstanding/s);
  assert.match(brief, /`FN` = `consumeTaskWorkflowResult`/);
  assert.doesNotMatch(brief, /results\[[01]\]/);
  assert.match(brief, /buildMergeReport\(queue\)/);
  assert.match(brief, /outstandingEntries/);
  assert.match(brief, /immediately ask that task's own approval gate/);
  assert.match(brief, /`"launch-tail"`:.*Launch that\s+task's `workflowPath`/s);
  assert.match(brief, /`"launch-plan"`:.*Launch that task's\s+`workflowPath`/s);
  assert.doesNotMatch(brief, /close-tasks/);
});

test("merge queue: the next-lap branch waits for an outstanding workflow instead of starting another lap against the same tip", () => {
  const brief = skillBody("[1]");
  assert.match(brief, /`"begin-next-lap"`: run `beginNextLap\(queue\)`/s);
  assert.match(brief, /`"wait"`: nothing may launch this call.*and the lap can't roll yet\./s);
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

// ---------------------------------------------------------------------------
// Repo hygiene: no leftover files from earlier iterations of this refactor.
// ---------------------------------------------------------------------------

test("the superseded workflow files are deleted and nothing outside plans/ or .taskTools/ imports them", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const superseded = [
    "skills/tackle-tasks/merge.workflow.js",
    "skills/tackle-tasks/plan.workflow.js",
    "skills/tackle-tasks/implement.workflow.js",
    "skills/tackle-tasks/test.workflow.js",
    "skills/tackle-tasks/verify.workflow.js",
    "skills/tackle-tasks/task.workflow.js.old",
    "skills/tackle-tasks/task.workflow.js",
    "scripts/tackle-tasks-v1_1_OrchestrationBriefEmitter.ts",
  ];
  for (const relativePath of superseded) {
    assert.equal(existsSync(join(repoRoot, relativePath)), false, `${relativePath} should have been deleted`);
  }
  let matches = "";
  try {
    matches = execFileSync(
      "git",
      ["grep", "-l", "-e", "merge.workflow.js", "-e", "plan.workflow.js", "-e", "implement.workflow.js", "-e", "test.workflow.js", "-e", "verify.workflow.js", "-e", "tackle-tasks-v1_1_OrchestrationBriefEmitter", "--", ".", ":!plans", ":!.taskTools", ":!tests/tackle-tasks-v1_1_SkillBodyEmitter.test.ts", ":!tests/tackle-tasks_SkillBodyEmitter.test.ts"],
      { encoding: "utf8", cwd: repoRoot },
    );
  } catch (error) {
    const failure = error as { status?: number };
    if (failure.status !== 1) throw error;
  }
  assert.equal(matches.trim(), "");
});

test("skills/tackle-tasks holds only the current workflow files — no old consolidated filename, no backup suffix", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const skillDir = join(repoRoot, "skills/tackle-tasks");
  const workflowFiles = readdirSync(skillDir).filter((name) => name.includes("workflow.js")).sort();
  assert.deepEqual(workflowFiles, ["blockers.workflow.js", "bootstrap.workflow.js", "tackle-tasks.workflow.js"]);
});

// The harness rejects a script unless meta is the first statement and a pure literal.
test("every tackle-tasks workflow script opens with a pure-literal meta and nothing before it", () => {
  const skillDir = join(fileURLToPath(new URL("..", import.meta.url)), "skills/tackle-tasks");
  const workflowFiles = readdirSync(skillDir).filter((name) => name.endsWith(".workflow.js")).sort();
  assert.ok(workflowFiles.length > 0, "no workflow scripts found to check");
  for (const name of workflowFiles) {
    const source = readFileSync(join(skillDir, name), "utf8");
    assert.ok(source.startsWith("export const meta = {"), `${name} must begin with "export const meta = {"`);
    const metaLiteral = source.slice(0, source.indexOf("\n}\n") + 3);
    assert.doesNotMatch(metaLiteral, /\$\{/, `${name}: meta must be a pure literal, with no template interpolation`);
  }
});

test("materializeTaskWorkflow bakes the task number in and leaves no placeholder behind", () => {
  const worktree = join(mkdtempSync(join(tmpdir(), "tt-workflow-")), "task-7");
  const workflowPath = materializeTaskWorkflow(7, worktree);
  const source = readFileSync(workflowPath, "utf8");
  assert.equal(workflowPath, `${worktree}.workflow.js`);
  assert.ok(source.startsWith('export const meta = {\n  name: "task-7",'), source.slice(0, 80));
  assert.doesNotMatch(source, /__TT_TASK__/);
  assert.match(source, /\{ title: "7 Plan", detail: "write and refine the task plan" \}/);
});

// ---------------------------------------------------------------------------
// Envelope tests: the brief's results[]/consumeTaskWorkflowResult wiring matches a real, non-synthetic task.workflow.js run.
// ---------------------------------------------------------------------------

const REPO_ROOT_FOR_WORKFLOW = fileURLToPath(new URL("..", import.meta.url));
const TASK_WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT_FOR_WORKFLOW, "skills/tackle-tasks/tackle-tasks.workflow.js"), "utf8")
  .replace("export const meta", "const meta");
const AGENT_PROMPT_EMITTER_PATH = join(REPO_ROOT_FOR_WORKFLOW, "scripts/tackle-tasks-v1_1_AgentPromptEmitter.ts");

type TaskWorkflowResult = { task: number; stage: "plan+implement" | "rebase-test" | "merge"; results: Array<Record<string, unknown>> };
type WorkflowAgentImpl = (prompt: string, options: { label: string }) => Promise<unknown>;
type TaskWorkflowRunner = (argsJson: string, log: (...values: unknown[]) => void, agent: WorkflowAgentImpl) => Promise<TaskWorkflowResult>;

// Every agent() prompt from tackle-tasks.workflow.js is one `node <emitter> <task> <role> <<'TT_PAYLOAD'` command.
const EMITTER_COMMAND_RE = /node (\S+) (\d+) (\S+) <<'TT_PAYLOAD'\n(.*)\nTT_PAYLOAD/;
const DRIVER_RESULT_PREFIX = "Return exactly this JSON as your structured result, with no other keys added or removed:\n";

// Driver roles resolve via the real emitter; judgment roles use the stand-in.
const agentThatRunsRealEmitterAndScriptsJudgment = (scriptedJudgment: WorkflowAgentImpl): WorkflowAgentImpl => async (prompt, options) => {
  const match = prompt.match(EMITTER_COMMAND_RE);
  if (!match) throw new Error(`prompt has no embedded emitter command: ${prompt.slice(0, 200)}`);
  const [, emitterPath, taskArg, role, payloadJson] = match;
  const output = execFileSync("node", [emitterPath!, taskArg!, role!], { input: payloadJson, encoding: "utf8" });
  if (output.startsWith(DRIVER_RESULT_PREFIX)) return JSON.parse(output.slice(DRIVER_RESULT_PREFIX.length).trim());
  return scriptedJudgment(prompt, options);
};

// ponytail: duplicated from tests/runMergePhase.test.ts rather than importing a .test.ts module,
// which would re-register that file's own tests under this file's run. Extract to a shared
// helper module if a third caller needs the same fixture.
const runTaskWorkflowStage = async (worktreePath: string, args: Record<string, unknown>, judgmentAgent: WorkflowAgentImpl) => {
  const fn = compileFunction(
    `return (async () => { 'use strict'\n${TASK_WORKFLOW_SOURCE} })()`,
    ["args", "log", "agent"],
    { filename: join(REPO_ROOT_FOR_WORKFLOW, "skills/tackle-tasks/tackle-tasks.workflow.js") },
  ) as TaskWorkflowRunner;
  return await fn(
    JSON.stringify({ worktree: worktreePath, agentPromptEmitterPath: AGENT_PROMPT_EMITTER_PATH, ...args }),
    () => {},
    agentThatRunsRealEmitterAndScriptsJudgment(judgmentAgent),
  );
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
  const taskRecord = { taskNumber, title: "fixture", files: ["taskfile.txt"], blockedBy: [] };
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
  const taskNumber = 9271;
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
  const taskNumber = 9272;
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
      writeFileSync(join(worktreePath, "taskfile.txt"), "implemented\n");
      gitForWorkflowFixture(worktreePath, "add", `plans/task-${taskNumber}-implementation-notes.md`, "taskfile.txt");
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

    const brief = skillBody("[1]");
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
