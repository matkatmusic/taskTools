import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { updateTaskFilesBrief } from "../scripts/update-task-files/updateTaskFilesBrief.ts";

// The commit whose SKILL.md still carried the body inline — the source text this script copied.
const preRefactorCommit = "970625df50ce150b774864e43e3dcb9cf28115b5";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const scriptPath = fileURLToPath(new URL("../scripts/update-task-files/updateTaskFilesBrief.ts", import.meta.url));
const getTaskDetailsPath = fileURLToPath(new URL("../scripts/shared/getTaskDetails.ts", import.meta.url));

function preRefactorBody(): string {
  const skill = execFileSync("git", ["show", `${preRefactorCommit}:skills/update-task-files/SKILL.md`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return skill.split("\n").slice(6).join("\n");
}

test("brief reproduces the pre-refactor skill body byte-for-byte once its substitutions are applied", () => {
  // Nonexistent task: a real task's description could quote these substituted tokens.
  const argsValue = "[999999]";
  const taskDetails = execFileSync("node", [getTaskDetailsPath, argsValue], { encoding: "utf8" }).trimEnd();
  const expected = preRefactorBody()
    .replace(
      '- repo root: !`pwd`\n- task details: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" \'$ARGUMENTS\'`',
      `- repo root: ${repoRoot}\n- task details: ${taskDetails}`,
    )
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", repoRoot)
    .replaceAll("$ARGUMENTS", argsValue);
  assert.equal(updateTaskFilesBrief(argsValue, taskDetails), expected);
});

test("brief leaves no unexpanded CLAUDE_PLUGIN_ROOT or $ARGUMENTS placeholder", () => {
  const brief = updateTaskFilesBrief("[1]", "task 1 (OPEN): {}");
  assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
  assert.doesNotMatch(brief, /\$ARGUMENTS/);
});

test("script reads arguments from stdin and embeds the live getTaskDetails.ts output", () => {
  const argsValue = "[75]";
  const expectedDetails = execFileSync("node", [getTaskDetailsPath, argsValue], { encoding: "utf8" }).trimEnd();
  const output = execFileSync("node", [scriptPath], { input: `${argsValue}\n`, encoding: "utf8" });
  assert.ok(output.startsWith(`- repo root: ${repoRoot}\n- task details: ${expectedDetails}\n`));
});

test("script fails loudly rather than emitting a brief that points nowhere", () => {
  assert.throws(() => execFileSync("node", [scriptPath], { input: "", encoding: "utf8", stdio: "pipe" }));
});
