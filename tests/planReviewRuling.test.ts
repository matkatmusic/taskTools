// planReviewRuling.ts: counts sections, and rules by fix count under 12 sections or by efficacy at 12+.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countSections,
  efficacyPercentage,
  getRulingForPlan,
  Ruling,
  rulingByFixCount,
  rulingByPercentage,
} from "../scripts/planReviewRuling.ts";

const scriptPath = new URL("../scripts/planReviewRuling.ts", import.meta.url).pathname;

function planWithSections(count: number): string {
  return ["# Title", ...Array.from({ length: count }, (_, i) => `## Section ${i}`)].join("\n");
}

test("rulings are consecutive integers ordered best to worst, so they index verdicts directly", () => {
  assert.deepEqual(Object.values(Ruling), [0, 1, 2, 3]);
  assert.equal(rulingByPercentage(100), Ruling.ACCEPTED_AS_IS);
  assert.equal(rulingByPercentage(92), Ruling.APPLY_FIX_THEN_ACCEPT);
  assert.equal(rulingByPercentage(75), Ruling.APPLY_FIX_THEN_REREVIEW);
  assert.equal(rulingByPercentage(74), Ruling.REWRITE_THEN_REVIEW);
  assert.equal(rulingByFixCount(0), Ruling.ACCEPTED_AS_IS);
  assert.equal(rulingByFixCount(1), Ruling.APPLY_FIX_THEN_ACCEPT);
  assert.equal(rulingByFixCount(4), Ruling.APPLY_FIX_THEN_REREVIEW);
  assert.equal(rulingByFixCount(5), Ruling.REWRITE_THEN_REVIEW);
});

test("counts ## and ### headings only", () => {
  assert.equal(countSections("# Title\n## One\n### Two\n#### Three\ntext\n##NoSpace"), 2);
});

test("efficacy floors at zero and survives a plan with no sections", () => {
  assert.equal(efficacyPercentage(4, 10), 0);
  assert.equal(efficacyPercentage(0, 3), 0);
  assert.equal(efficacyPercentage(12, 1), 92);
});

test("under 12 sections the fix count decides, ignoring the harsh percentage", () => {
  assert.match(getRulingForPlan(4, 1, "p.md"), /can be used after incorporating the fix below\./);
  assert.match(getRulingForPlan(4, 3, "p.md"), /must be amended with the fixes below/);
  assert.match(getRulingForPlan(4, 5, "p.md"), /must have the issues flagged below rewritten according to the fixes below/);
  assert.match(getRulingForPlan(4, 0, "p.md"), /can be used as is\./);
});

test("at 12 sections the efficacy percentage decides instead", () => {
  assert.match(getRulingForPlan(12, 0, "p.md"), /can be used as is\./);
  assert.match(getRulingForPlan(12, 1, "p.md"), /can be used after incorporating the fix below\./);
  assert.match(getRulingForPlan(12, 2, "p.md"), /must be amended with the fixes below/);
  assert.match(getRulingForPlan(20, 6, "p.md"), /must have the issues flagged below rewritten according to the fixes below/);
});

test("the two scales disagree, and the section count picks the winner", () => {
  assert.match(getRulingForPlan(11, 5, "p.md"), /must have the issues flagged below rewritten according to the fixes below/);
  assert.match(getRulingForPlan(40, 5, "p.md"), /must be amended with the fixes below/);
});

test("names the plan and pluralises by the fix count", () => {
  assert.match(getRulingForPlan(4, 1, "/abs/p.md"), /^\/abs\/p\.md can be used after incorporating the fix below\. Keep/);
  assert.match(getRulingForPlan(40, 2, "/abs/p.md"), /incorporating the fixes below\./);
  assert.match(getRulingForPlan(12, 2, "/abs/p.md"), /^\/abs\/p\.md must be amended/);
});

test("fails loudly rather than printing NaN into the report", () => {
  const plan = join(mkdtempSync(join(tmpdir(), "ruling-")), "p.md");
  writeFileSync(plan, planWithSections(4));
  const stderrFor = (args: string[]) => {
    try {
      execFileSync("node", [scriptPath, ...args], { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      return String((error as { stderr: string }).stderr);
    }
    return "";
  };
  assert.match(stderrFor([]), /no plan file path given/);
  assert.match(stderrFor(["/tmp/nope/missing.md", "2"]), /plan file does not exist/);
  assert.match(stderrFor([plan]), /fix count must be a whole number/);
  assert.match(stderrFor([plan, "two"]), /fix count must be a whole number/);
});

test("prints the three template lines for a real plan file", () => {
  const plan = join(mkdtempSync(join(tmpdir(), "ruling-")), "p.md");
  writeFileSync(plan, planWithSections(4));
  const printed = execFileSync("node", [scriptPath, plan, "2"], { encoding: "utf8" });
  const postComment = " Keep your edits small. Do not state that the edits are the result of feedback from an amendment.";
  assert.equal(printed, `Sections: 4 | Fixes: 2\nEfficacy: 50%\nRuling: ${plan} must be amended with the fixes below, then re-reviewed before use.${postComment}\n`);
});
