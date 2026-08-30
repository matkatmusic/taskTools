import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { clarifyTaskBrief } from "../scripts/clarifyTaskBrief.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const scriptPath = fileURLToPath(new URL("../scripts/clarifyTaskBrief.ts", import.meta.url));

test("test_clarifyTaskBriefNamesTheTasksAndTheAnswerScript", () => {
  const brief = clarifyTaskBrief("[94,95]", "task 94 (OPEN):\n{}");
  assert.ok(brief.startsWith("- tasks to clarify: task 94 (OPEN):\n{}\n"));
  assert.ok(brief.includes("`[94,95]` holds the whole invocation"));
  assert.ok(brief.includes(`node "${repoRoot}/scripts/clarifyTask.ts" <<'CLARIFYEOF'`));
  assert.ok(brief.includes("never edit tasks.json yourself"));
});

test("test_clarifyTaskBriefScriptFailsOnEmptyStdin", () => {
  const result = execFileSync("sh", ["-c", `printf '' | node "${scriptPath}"; echo "exit=$?"`], { encoding: "utf8", cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] });
  assert.match(result, /exit=1/);
});
