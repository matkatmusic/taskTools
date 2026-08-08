import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
