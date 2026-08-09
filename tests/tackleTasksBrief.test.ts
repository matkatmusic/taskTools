import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tackleTasksBrief } from "../scripts/tackleTasksBrief.ts";
import { TASKS_PER_COMMAND } from "../scripts/taskStats.ts";

const scriptPath = fileURLToPath(new URL("../scripts/tackleTasksBrief.ts", import.meta.url));
const checkBlockersPath = fileURLToPath(new URL("../scripts/checkBlockers.ts", import.meta.url));

test("brief leaves no unexpanded CLAUDE_PLUGIN_ROOT or $ARGUMENTS placeholder", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
  assert.doesNotMatch(brief, /\$ARGUMENTS/);
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
  assert.match(brief, /Args for each launch: `\{task, typecheckCommand\}`/);
  assert.match(brief, /task-notification back to you/);
  assert.doesNotMatch(brief, /wait for each to finish before starting/);
  assert.doesNotMatch(brief, /stepOutputsFile/);
  assert.doesNotMatch(brief, /mergeCommand/);
  assert.doesNotMatch(brief, /Step 1 — plan/);
  assert.match(brief, new RegExp(`Keep up to ${TASKS_PER_COMMAND} task\\.workflow\\.js runs in flight`));
  assert.match(brief, /sliding window, not\s+batches of/);
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
  assert.match(brief, /nextQueueStep\(queue\)/);
  assert.match(brief, /launch `.*task\.workflow\.js` as a background workflow with args `\{task: taskNumber, stage, repositoryManifest\}`/);
  assert.match(brief, /rebase-test.*or merge workflow.*outstanding/s);
  assert.match(brief, /recordStageOutcome\(queue, taskNumber, stage, outcome\)/);
  assert.match(brief, /shouldEndQueue\(queue, workflowOutstanding\)/);
  assert.match(brief, /buildMergeReport\(queue\)/);
  assert.match(brief, /outstandingEntries/);
  assert.match(brief, /immediately ask that task's own approval gate/);
  assert.match(brief, /do not launch anything.*wait for that workflow's completion notification/s);
  assert.doesNotMatch(brief, /close-tasks/);
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
