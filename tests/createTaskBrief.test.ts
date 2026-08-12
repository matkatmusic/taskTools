import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTaskBrief } from "../scripts/createTaskBrief.ts";

// The commit whose SKILL.md still carried the body inline — the source text this script copied.
const preRefactorCommit = "970625df50ce150b774864e43e3dcb9cf28115b5";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const scriptPath = fileURLToPath(new URL("../scripts/createTaskBrief.ts", import.meta.url));
const nextTaskNumberPath = fileURLToPath(new URL("../scripts/nextTaskNumber.ts", import.meta.url));
const taskTemplatePath = fileURLToPath(new URL("../skills/create-task/template/taskTemplate.json", import.meta.url));
const appendTaskPath = fileURLToPath(new URL("../scripts/appendTask.ts", import.meta.url));

function preRefactorBody(): string {
  const skill = execFileSync("git", ["show", `${preRefactorCommit}:skills/create-task/SKILL.md`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return skill.split("\n").slice(6).join("\n");
}

test("brief reproduces the pre-refactor skill body byte-for-byte once its substitutions are applied", () => {
  const argsValue = "test task description";
  const taskNumber = execFileSync("node", [nextTaskNumberPath], { encoding: "utf8" }).trimEnd();
  const version = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trimEnd();
  const taskTemplate = readFileSync(taskTemplatePath, "utf8").trimEnd();
  const expected = preRefactorBody()
    .replace(
      '- taskNumber to use: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`',
      `- taskNumber to use: ${taskNumber}`,
    )
    .replace('- version to use: !`git rev-parse HEAD`', `- version to use: ${version}`)
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", repoRoot)
    .replaceAll("$ARGUMENTS", argsValue)
    .replace(`!\`cat "${repoRoot}/skills/create-task/template/taskTemplate.json"\``, taskTemplate)
    // C86-23: create-task no longer edits tasks.json directly; it hands the object to appendTask.ts under a lock.
    .replace(
      "Append ONE object to the `tasks.json` array as its LAST element — at the very end of the array, after every existing entry. Never insert it in the middle and never reorder or renumber the existing entries. Use this template:",
      "Gather every field below for ONE task object — do not write it into `tasks.json` yourself; a script appends it under a lock later in this brief. Use this template:",
    )
    .replace(
      "Finally, confirm to the user: the task number and title that were added.",
      "Once every field above is populated, append the task by sending the completed object as JSON on stdin to this script — it is the only permitted way to add the object to `tasks.json`, it appends under a lock, and it prints back the appended task including its authoritative `taskNumber`; never edit `tasks.json` yourself:\n\n" +
        `\`\`\`\nnode ${appendTaskPath}\n\`\`\`\n\n` +
        "Finally, confirm to the user: the `taskNumber` the script returned, and the title that was added.",
    );
  assert.equal(createTaskBrief(argsValue, taskNumber, version, taskTemplate), expected);
});

test("brief leaves no unexpanded CLAUDE_PLUGIN_ROOT or $ARGUMENTS placeholder", () => {
  const brief = createTaskBrief("test task", "1", "abc123", "{}");
  assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
  assert.doesNotMatch(brief, /\$ARGUMENTS/);
});

test("script reads arguments from stdin and embeds the live nextTaskNumber.ts output", () => {
  const argsValue = "test task description";
  const expectedTaskNumber = execFileSync("node", [nextTaskNumberPath], { encoding: "utf8" }).trimEnd();
  const output = execFileSync("node", [scriptPath], { input: `${argsValue}\n`, encoding: "utf8" });
  assert.ok(output.startsWith(`- taskNumber to use: ${expectedTaskNumber}\n`));
});

test("script fails loudly rather than emitting a brief that points nowhere", () => {
  assert.throws(() => execFileSync("node", [scriptPath], { input: "", encoding: "utf8", stdio: "pipe" }));
});
