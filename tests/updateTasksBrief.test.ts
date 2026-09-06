import { test } from "node:test";
import assert from "node:assert/strict";
import { brief } from "../scripts/update-tasks/updateTasksBrief.ts";

// Disabled: pinned the brief to the pre-refactor SKILL.md, so it fails on every intentional wording edit.
//
// import { execFileSync } from "node:child_process";
// import { fileURLToPath } from "node:url";
// const preRefactorCommit = "2ec24aaf94ece915af99ecf22d0610f48c1f857a";
// const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
// const extractOpenSectionsPath = fileURLToPath(new URL("../scripts/shared/extractOpenSections.ts", import.meta.url));
// const getTaskDetailsPath = fileURLToPath(new URL("../scripts/shared/getTaskDetails.ts", import.meta.url));
//
// function preRefactorBody(): string {
//   const skill = execFileSync("git", ["show", `${preRefactorCommit}:skills/update-tasks/SKILL.md`], {
//     cwd: repoRoot,
//     encoding: "utf8",
//   });
//   return skill.split("\n").slice(6).join("\n");
// }
//
// test("brief reproduces the pre-refactor skill body byte-for-byte once its substitutions are applied", () => {
//   const filesToProcess = execFileSync("node", [extractOpenSectionsPath, "--list"], { encoding: "utf8" }).trimEnd();
//   const extractedSections = execFileSync("node", [extractOpenSectionsPath], { encoding: "utf8" }).trimEnd();
//   const titles = execFileSync("node", [getTaskDetailsPath], { encoding: "utf8" }).trimEnd();
//   const expected = preRefactorBody()
//     .replace(
//       '1. Files to process: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/extractOpenSections.ts" --list`',
//       `1. Files to process: ${filesToProcess}`,
//     )
//     .replace(
//       '!`node "${CLAUDE_PLUGIN_ROOT}/scripts/extractOpenSections.ts"`',
//       extractedSections,
//     )
//     .replace(
//       'Titles: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts"`',
//       `Titles: ${titles}`,
//     )
//     .replaceAll("${CLAUDE_PLUGIN_ROOT}", repoRoot);
//   assert.equal(brief, expected);
// });

test("brief leaves no unexpanded CLAUDE_PLUGIN_ROOT placeholder", () => {
  assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
});
