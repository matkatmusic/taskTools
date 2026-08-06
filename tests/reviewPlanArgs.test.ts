// reviewPlanArgs.ts: splits the plan path off the target, quoted or not, and names the amendment file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { amendmentPath, splitPlanPath } from "../scripts/reviewPlanArgs.ts";

test("splits an unquoted plan path from the target", () => {
  const parsed = splitPlanPath("plans/ultra-fuzzy-star.md the state of the codebase");
  assert.equal(parsed.planPath, "plans/ultra-fuzzy-star.md");
  assert.equal(parsed.target, "the state of the codebase");
});

test("keeps a quoted plan path containing spaces intact", () => {
  const parsed = splitPlanPath('"plans/ultra fuzzy star.md" the codebase on new-usage-graph');
  assert.equal(parsed.planPath, "plans/ultra fuzzy star.md");
  assert.equal(parsed.target, "the codebase on new-usage-graph");
});

test("treats apostrophes and shell metacharacters in the target as plain text", () => {
  const parsed = splitPlanPath("plans/p.md the codebase's `date` $(echo x) state");
  assert.equal(parsed.target, "the codebase's `date` $(echo x) state");
});

test("returns an empty target when only a plan path is given", () => {
  assert.equal(splitPlanPath("plans/p.md").target, "");
});

test("names the amendment file next to the plan, without the .md suffix", () => {
  assert.equal(amendmentPath("/abs/plans/ultra-fuzzy-star.md"), "plans/ultra-fuzzy-star-amendment.md");
});
