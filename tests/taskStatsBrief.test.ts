import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brief } from "../scripts/taskStatsBrief.ts";

test("brief embeds live taskStats.ts output under the stats label", () => {
  const taskStatsPath = fileURLToPath(new URL("../scripts/taskStats.ts", import.meta.url));
  const stats = execFileSync("node", [taskStatsPath], { encoding: "utf8" }).trimEnd();
  assert.ok(brief.includes(`- stats: ${stats}`));
});

test("brief keeps the verbatim print instruction", () => {
  assert.ok(
    brief.includes(
      "Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question."
    )
  );
});
