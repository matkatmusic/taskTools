// extractOpenSections.ts: prints open-question/remains sections under a banner, stops at next header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "extractOpenSections.ts");

test("prints banner-labelled sections and stops at the next header", () => {
  const dir = mkdtempSync(join(tmpdir(), "taskTools-extract-"));
  const note = join(dir, "implementation-notes-x.md");
  writeFileSync(note, [
    "## 2026-01-01 — entry one",
    "### Open questions",
    "- question A",
    "## 2026-01-02 — entry two",
    "### Open questions",
    "- question B",
    "### Not extracted",
    "- hidden",
  ].join("\n"));
  const handoff = join(dir, "handoff-x.md");
  writeFileSync(handoff, ["# Handoff", "## What Remains", "1. step one", "## Key Files", "- secret.ts"].join("\n"));

  const output = execFileSync("node", ["--no-inspect", SCRIPT, note, handoff], { encoding: "utf8" });
  assert.equal(output.split(`=== ${note} ===`).length, 3);
  assert.ok(output.includes("- question A") && output.includes("- question B"));
  assert.ok(output.includes("1. step one"));
  assert.ok(!output.includes("- hidden") && !output.includes("secret.ts"));
});
