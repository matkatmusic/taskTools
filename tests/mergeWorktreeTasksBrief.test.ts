import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brief } from "../scripts/merge-worktree-tasks/mergeWorktreeTasksBrief.ts";

// The commit whose SKILL.md still carried the body inline — the source text this script copied.
const preRefactorCommit = "970625df50ce150b774864e43e3dcb9cf28115b5";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const mergeTaskWorktreesPath = fileURLToPath(new URL("../scripts/merge-worktree-tasks/mergeTaskWorktrees.ts", import.meta.url));

function preRefactorBody(): string {
  const skill = execFileSync("git", ["show", `${preRefactorCommit}:skills/merge-worktree-tasks/SKILL.md`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return skill.split("\n").slice(5).join("\n");
}

test("brief reproduces the pre-refactor skill body byte-for-byte once its substitutions are applied", () => {
  const unmergedWorktrees = execFileSync("node", [mergeTaskWorktreesPath, "--discover"], { encoding: "utf8" }).trimEnd();
  const expected = preRefactorBody()
    .replace('- repo root: !`pwd`', `- repo root: ${repoRoot}`)
    .replace(
      '- unmerged worktrees: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/mergeTaskWorktrees.ts" --discover`',
      `- unmerged worktrees: ${unmergedWorktrees}`,
    )
    .replaceAll("${CLAUDE_PLUGIN_ROOT}/scripts/mergeTaskWorktrees.ts", mergeTaskWorktreesPath)
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", repoRoot);
  assert.equal(brief, expected);
});

test("brief leaves no unexpanded CLAUDE_PLUGIN_ROOT placeholder", () => {
  assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
});

test("brief embeds the absolute mergeTaskWorktrees.ts path in the --merge instruction", () => {
  assert.ok(brief.includes(`\`node "${mergeTaskWorktreesPath}" --merge <worktree path>\``));
});
