// Turns a plan's section count and fix count into the /review-plan ruling, so no prose judgement is needed.
import { existsSync, readFileSync } from "node:fs";

// Below this, absolute fix counts decide the ruling; at or above it, the efficacy percentage does.
const PERCENTAGE_SCALE_MINIMUM_SECTIONS = 12;

export function countSections(planText: string): number {
  return planText.split("\n").filter(line => /^#{2,3}\s/.test(line)).length;
}

export function efficacyPercentage(sectionCount: number, fixesCount: number): number {
  if (sectionCount <= 0) return 0;
  return Math.max(0, Math.round(((sectionCount - fixesCount) / sectionCount) * 100));
}

// Ordered best to worst, and numeric like a C++ enum so a Ruling indexes VERDICTS directly.
export const Ruling = {
  ACCEPTED_AS_IS: 0,
  APPLY_FIX_THEN_ACCEPT: 1,
  APPLY_FIX_THEN_REREVIEW: 2,
  REWRITE_THEN_REVIEW: 3,
} as const;
export type Ruling = (typeof Ruling)[keyof typeof Ruling];

export function rulingByPercentage(efficacy: number): Ruling {
  if (efficacy === 100) return Ruling.ACCEPTED_AS_IS;
  if (efficacy >= 92) return Ruling.APPLY_FIX_THEN_ACCEPT;
  if (efficacy >= 75) return Ruling.APPLY_FIX_THEN_REREVIEW;
  return Ruling.REWRITE_THEN_REVIEW;
}

export function rulingByFixCount(fixesCount: number): Ruling {
  if (fixesCount === 0) return Ruling.ACCEPTED_AS_IS;
  if (fixesCount === 1) return Ruling.APPLY_FIX_THEN_ACCEPT;
  if (fixesCount <= 4) return Ruling.APPLY_FIX_THEN_REREVIEW;
  return Ruling.REWRITE_THEN_REVIEW;
}

export function getRulingForPlan(sectionCount: number, fixesCount: number, plan: string): string {
  const ruling =
    sectionCount >= PERCENTAGE_SCALE_MINIMUM_SECTIONS
      ? rulingByPercentage(efficacyPercentage(sectionCount, fixesCount))
      : rulingByFixCount(fixesCount);
  const postComment = " Keep your edits small. Do not state that the edits are the result of feedback from an amendment.";
  const verdicts = [
    "can be used as is.",
    `can be used after incorporating the ${fixesCount === 1 ? "fix" : "fixes"} below.` + postComment,
    "must be amended with the fixes below, then re-reviewed before use." + postComment,
    "must have the issues flagged below rewritten according to the fixes below, then re-reviewed before use." + postComment,
  ];
  return `${plan} ${verdicts[ruling]}`;
}

// A bad fix count would otherwise print "Efficacy: NaN%" straight into the amendment report.
function fail(problem: string): never {
  process.stderr.write(`planReviewRuling: ${problem}\nusage: node planReviewRuling.ts <plan file path> <fix count>\n`);
  process.exit(1);
}

if (process.argv[1]?.endsWith("planReviewRuling.ts")) {
  const [plan, fixes] = process.argv.slice(2);
  const fixesCount = Number(fixes);
  if (!plan) fail("no plan file path given");
  if (!existsSync(plan)) fail(`plan file does not exist: ${plan}`);
  if (!Number.isInteger(fixesCount) || fixesCount < 0) fail(`fix count must be a whole number, got: ${fixes}`);
  const sectionCount = countSections(readFileSync(plan, "utf8"));
  process.stdout.write(
    `Sections: ${sectionCount} | Fixes: ${fixesCount}\n` +
      `Efficacy: ${efficacyPercentage(sectionCount, fixesCount)}%\n` +
      `Ruling: ${getRulingForPlan(sectionCount, fixesCount, plan)}\n`,
  );
}
