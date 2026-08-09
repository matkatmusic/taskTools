// Retired: replaced by create-task_SkillBodyEmitter.ts and create-task_AgentPromptEmitter.ts.
// import { test } from "node:test";
// import assert from "node:assert/strict";
// import { execFileSync } from "node:child_process";
// import { fileURLToPath } from "node:url";
// import { createTaskBrief } from "../scripts/createTaskBrief.ts";
//
// const scriptPath = fileURLToPath(new URL("../scripts/createTaskBrief.ts", import.meta.url));
// const nextTaskNumberPath = fileURLToPath(new URL("../scripts/nextTaskNumber.ts", import.meta.url));
//
// // Disabled: pinned the brief to the pre-refactor SKILL.md, so it fails on every intentional wording edit.
// //
// // import { readFileSync } from "node:fs";
// // const preRefactorCommit = "970625df50ce150b774864e43e3dcb9cf28115b5";
// // const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
// // const taskTemplatePath = fileURLToPath(new URL("../skills/create-task/template/taskTemplate.json", import.meta.url));
// //
// // function preRefactorBody(): string {
// //   const skill = execFileSync("git", ["show", `${preRefactorCommit}:skills/create-task/SKILL.md`], {
// //     cwd: repoRoot,
// //     encoding: "utf8",
// //   });
// //   return skill.split("\n").slice(6).join("\n");
// // }
// //
// // test("brief reproduces the pre-refactor skill body byte-for-byte once its substitutions are applied", () => {
// //   const argsValue = "test task description";
// //   const taskNumber = execFileSync("node", [nextTaskNumberPath], { encoding: "utf8" }).trimEnd();
// //   const version = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trimEnd();
// //   const taskTemplate = readFileSync(taskTemplatePath, "utf8").trimEnd();
// //   const expected = preRefactorBody()
// //     .replace(
// //       '- taskNumber to use: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`',
// //       `- taskNumber to use: ${taskNumber}`,
// //     )
// //     .replace('- version to use: !`git rev-parse HEAD`', `- version to use: ${version}`)
// //     .replaceAll("${CLAUDE_PLUGIN_ROOT}", repoRoot)
// //     .replaceAll("$ARGUMENTS", argsValue)
// //     .replace(`!\`cat "${repoRoot}/skills/create-task/template/taskTemplate.json"\``, taskTemplate);
// //   assert.equal(createTaskBrief(argsValue, taskNumber, version, taskTemplate), expected);
// // });
//
// test("brief leaves no unexpanded CLAUDE_PLUGIN_ROOT or $ARGUMENTS placeholder", () => {
//   const brief = createTaskBrief("test task", "1", "abc123", "{}");
//   assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
//   assert.doesNotMatch(brief, /\$ARGUMENTS/);
// });
//
// test("script reads arguments from stdin and embeds the live nextTaskNumber.ts output", () => {
//   const argsValue = "test task description";
//   const expectedTaskNumber = execFileSync("node", [nextTaskNumberPath], { encoding: "utf8" }).trimEnd();
//   const output = execFileSync("node", [scriptPath], { input: `${argsValue}\n`, encoding: "utf8" });
//   assert.ok(output.startsWith(`- taskNumber to use: ${expectedTaskNumber}\n`));
// });
//
// test("script fails loudly rather than emitting a brief that points nowhere", () => {
//   assert.throws(() => execFileSync("node", [scriptPath], { input: "", encoding: "utf8", stdio: "pipe" }));
// });
