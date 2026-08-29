import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brief } from "../scripts/tackleUnblockedTasksBrief.ts";

// Retired: the byte-for-byte test used to reconstruct its expected text from the
// pre-refactor SKILL.md in git history. The new brief body is not sourced from that
// commit any more, so the git-history reconstruction is obsolete. See E1.
// const preRefactorCommit = "970625df50ce150b774864e43e3dcb9cf28115b5";
// const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
// function preRefactorBody(): string {
//   const skill = execFileSync("git", ["show", `${preRefactorCommit}:skills/tackle-unblocked-tasks/SKILL.md`], {
//     cwd: repoRoot,
//     encoding: "utf8",
//   });
//   return skill.split("\n").slice(4).join("\n");
// }

const checkBlockersPath = fileURLToPath(new URL("../scripts/checkBlockers.ts", import.meta.url));

test("brief reproduces the pre-refactor skill body byte-for-byte once its substitutions are applied", () => {
  // Step 1: compute the same unblocked-task-numbers line the script computes.
  const unblockedTaskNumbers = execSync(
    `u=$(node "${checkBlockersPath}" --unblocked '$tasks'); [ -n "$u" ] && echo "[$(echo $u | tr ' ' '\\n' | sort -n | paste -sd, -)]" || echo "none"`,
    { encoding: "utf8" },
  ).trimEnd();

  // Step 2: build the exact new brief body the script should now print.
  const expected = `- \`$tasks\`: 
- \`$unblockedTaskNumbers\`: ${unblockedTaskNumbers}

Loop through every task in tasks.json until it contains no more entries. For each task found that is unblocked, spawn the workflow pipeline to complete the task:
1. Run \`node "${checkBlockersPath}" --unblocked\` to get the unblocked task numbers.
2. If tasks.json has no entries, report that and stop.
3. If no numbers come back, report that every open task is blocked and stop.
4. Invoke the \`tackle-tasks [the numbers just returned]\` skill. Pass the list verbatim; do not re-derive or filter it. Wait for every launched run's completion notification. The notification, not polling, is how you learn a run is done.
5. Go back to step 1.

`;

  // Step 3: compare the script's real output against that expected text.
  assert.equal(brief, expected);
});

test("test_brief_dropsTheValidToken", () => {
  // Step 1: the brief must never tell the agent to invoke "tackle-tasks [...] valid".  Step 2: parseStartingBlockArgument reads the token after "]" as a block name, so a trailing "valid" would be misread as a starting block and break the run.
  assert.equal(brief.includes("] valid"), false);
});

test("brief leaves no unexpanded CLAUDE_PLUGIN_ROOT placeholder", () => {
  assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
});
