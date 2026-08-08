import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pickATaskBrief } from "../scripts/pickATaskBrief.ts";

// The commit whose SKILL.md still carried the body inline — the source text this script copied.
const preRefactorCommit = "2ec24aaf94ece915af99ecf22d0610f48c1f857a";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const scriptPath = fileURLToPath(new URL("../scripts/pickATaskBrief.ts", import.meta.url));
const getTaskDetailsPath = fileURLToPath(new URL("../scripts/getTaskDetails.ts", import.meta.url));
const checkBlockersPath = fileURLToPath(new URL("../scripts/checkBlockers.ts", import.meta.url));

function preRefactorBody(): string {
  const skill = execFileSync("git", ["show", `${preRefactorCommit}:skills/pick-a-task/SKILL.md`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return skill.split("\n").slice(5).join("\n");
}

// grep exits non-zero when it matches nothing; that is not a failure here, just an empty result.
function openTasksReport(): string {
  try {
    return execSync(`node "${getTaskDetailsPath}" | grep ^OPEN`, { encoding: "utf8" }).trimEnd();
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    return typeof stdout === "string" ? stdout.trimEnd() : "";
  }
}

test("brief reproduces the pre-refactor skill body byte-for-byte once its substitutions are applied", () => {
  const argsValue = "99999";
  const openTasks = openTasksReport();
  const blockedStatus = execFileSync("node", [checkBlockersPath], { encoding: "utf8" }).trimEnd();
  const expected = preRefactorBody()
    .replace(
      'Open tasks: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" | grep ^OPEN`',
      `Open tasks: ${openTasks}`,
    )
    .replace(
      'Blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts"`',
      `Blocked status: ${blockedStatus}`,
    )
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", repoRoot)
    .replaceAll("$ARGUMENTS", argsValue);
  assert.equal(pickATaskBrief(argsValue, openTasks, blockedStatus), expected);
});

test("brief leaves no unexpanded CLAUDE_PLUGIN_ROOT or $ARGUMENTS placeholder", () => {
  const brief = pickATaskBrief("2", "OPEN 1: sample", "task 1: unblocked");
  assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
  assert.doesNotMatch(brief, /\$ARGUMENTS/);
});

test("script reads arguments from stdin and embeds the live checkBlockers.ts output", () => {
  const argsValue = "1";
  const expectedStatus = execFileSync("node", [checkBlockersPath], { encoding: "utf8" }).trimEnd();
  const output = execFileSync("node", [scriptPath], { input: `${argsValue}\n`, encoding: "utf8" });
  assert.match(output, new RegExp(`Blocked status: ${expectedStatus.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("script fails loudly rather than emitting a brief that points nowhere", () => {
  assert.throws(() => execFileSync("node", [scriptPath], { input: "", encoding: "utf8", stdio: "pipe" }));
});
