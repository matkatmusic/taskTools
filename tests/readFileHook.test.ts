import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const hook = new URL("../scripts/hooks/readFileHook.ts", import.meta.url).pathname;
const run = (payload: object) => execFileSync("node", ["--no-inspect", hook], { input: JSON.stringify(payload), encoding: "utf8" });
const prompt = (text: string) => run({ hook_event_name: "UserPromptSubmit", prompt: text });
const skill = (args: string) => run({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "read-file", args } });

test("injects the file text for a typed /read-file <path>", () => {
  const out = JSON.parse(prompt(`/read-file ${hook}`)).hookSpecificOutput;
  assert.equal(out.hookEventName, "UserPromptSubmit");
  assert.match(out.additionalContext, /Injects files into context/);
});

test("injects the file text when an agent invokes the read-file skill", () => {
  const out = JSON.parse(skill(hook)).hookSpecificOutput;
  assert.equal(out.hookEventName, "PostToolUse");
  assert.match(out.additionalContext, /Injects files into context/);
});

test("reports a missing file instead of throwing", () => {
  assert.match(JSON.parse(prompt("/read-file /no/such/file")).hookSpecificOutput.additionalContext, /no file at \/no\/such\/file/);
});

test("passes other prompts and other skills through silently", () => {
  assert.equal(prompt("/view-task 5"), "");
  assert.equal(run({ hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "view-task", args: "5" } }), "");
});

test("injects several files, separated by a ==== path ==== header", () => {
  const out = JSON.parse(prompt(`/read-file ${hook} /no/such/file`)).hookSpecificOutput.additionalContext;
  assert.match(out, new RegExp(`^==== ${hook} ====\\n// Injects files into context`));
  assert.match(out, /\n\n==== \/no\/such\/file ====\nread-file: no file at \/no\/such\/file$/);
});

test("keeps a quoted path with spaces whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "read-file-"));
  const spaced = join(dir, "a b.txt");
  writeFileSync(spaced, "spaced file contents\n");
  const out = JSON.parse(prompt(`/read-file "${spaced}" ${hook}`)).hookSpecificOutput.additionalContext;
  assert.match(out, new RegExp(`^==== ${spaced} ====\\nspaced file contents`));
  assert.match(out, new RegExp(`\\n\\n==== ${hook} ====`));
  rmSync(dir, { recursive: true });
});
