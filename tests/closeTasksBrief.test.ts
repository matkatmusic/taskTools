import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closeTasksBrief } from "../scripts/closeTasksBrief.ts";

// The commit whose SKILL.md still carried the body inline — the source text this script copied.
const preRefactorCommit = "970625df50ce150b774864e43e3dcb9cf28115b5";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const scriptPath = fileURLToPath(new URL("../scripts/closeTasksBrief.ts", import.meta.url));
const getTaskDetailsPath = fileURLToPath(new URL("../scripts/getTaskDetails.ts", import.meta.url));

function preRefactorBody(): string {
  const skill = execFileSync("git", ["show", `${preRefactorCommit}:skills/close-tasks/SKILL.md`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return skill.split("\n").slice(7).join("\n");
}

test("brief reproduces the pre-refactor skill body byte-for-byte once its substitutions are applied", () => {
  const argsValue = "[99999] valid";
  const taskDetails = execFileSync("node", [getTaskDetailsPath, argsValue], { encoding: "utf8" }).trimEnd();
  const expected = preRefactorBody()
    .replace(
      '- tasks to close: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" \'$ARGUMENTS\'`',
      `- tasks to close: ${taskDetails}`,
    )
    .replaceAll("${CLAUDE_PLUGIN_ROOT}/scripts/closeTasks.ts", `${repoRoot}/scripts/closeTasks.ts`)
    .replaceAll("$ARGUMENTS", argsValue);
  assert.equal(closeTasksBrief(argsValue, taskDetails), expected);
});

test("brief leaves no unexpanded CLAUDE_PLUGIN_ROOT or $ARGUMENTS placeholder", () => {
  const brief = closeTasksBrief("[1]", "task 1: unblocked");
  assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
  assert.doesNotMatch(brief, /\$ARGUMENTS/);
});

test("script reads arguments from stdin and embeds the live getTaskDetails.ts output", () => {
  const argsValue = "[99999] valid";
  const expectedDetails = execFileSync("node", [getTaskDetailsPath, argsValue], { encoding: "utf8" }).trimEnd();
  const output = execFileSync("node", [scriptPath], { input: `${argsValue}\n`, encoding: "utf8" });
  assert.ok(output.startsWith(`- tasks to close: ${expectedDetails}\n`));
});

test("script fails loudly rather than emitting a brief that points nowhere", () => {
  assert.throws(() => execFileSync("node", [scriptPath], { input: "", encoding: "utf8", stdio: "pipe" }));
});
