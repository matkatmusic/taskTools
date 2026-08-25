// WHAT_IS_REVIEW_VERDICT, from pipeline-reviewPlan.mmd. Ported from scripts/tackle-tasks/recordPlanReview.ts.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { efficacyPercentage, Ruling, rulingByFixCount, rulingByPercentage } from "../../planReviewRuling.ts";
import type { PlanReview } from "../../tackle-tasks/recordPlanReview.ts";

export type WhatIsReviewVerdictPacket = {
    taskNumber: number;
    taskStateRoot: string;
    repoRoot: string;
    planFile: string;
    runId: string;
    sourceBranch: string;
    // plan: unknown;
    review: PlanReview;
};

// Below this, absolute fix counts decide the ruling; at or above it, the efficacy percentage does.
const PERCENTAGE_SCALE_MINIMUM_SECTIONS = 12;

// Ruling order is best to worst, so a Ruling indexes this directly.
const VERDICTS = ["ACCEPT", "AMEND_THEN_ACCEPT", "AMEND", "SCRAP"] as const;

const fixNote = (fix: PlanReview["fixes"][number]) => `${fix.fix}\n\nDurable because: ${fix.durableBecause}`;

function decideVerdict(packet: WhatIsReviewVerdictPacket): { verdict: string; notes: string } {
    const review = packet.review;
    // The reviewer never saw the plan, so ERROR is reported as the verdict rather than ruled on.
    if (review.outcome === "ERROR") {
        return { verdict: "ERROR", notes: `${review.message} missing: ${review.missingFiles.join(", ")}` };
    }
    const plan = JSON.parse(readFileSync(packet.planFile, "utf8"));
    const fixes = review.fixes;
    const sectionCount = plan.sections.length;
    const ruling = sectionCount >= PERCENTAGE_SCALE_MINIMUM_SECTIONS
        ? rulingByPercentage(efficacyPercentage(sectionCount, fixes.length))
        : rulingByFixCount(fixes.length);
    const notes = fixes.map((fix) => `[${fix.sectionId}] ${fixNote(fix)}`).join("\n\n");
    return { verdict: VERDICTS[ruling], notes };
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as WhatIsReviewVerdictPacket;
    const { verdict, notes } = decideVerdict(packet);
    return {
        box: "WHAT_IS_REVIEW_VERDICT",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: `VERDICT_${verdict}`,
        taskNumber: packet.taskNumber,
        taskStateRoot: packet.taskStateRoot,
        repoRoot: packet.repoRoot,
        planFile: packet.planFile,
        runId: packet.runId,
        sourceBranch: packet.sourceBranch,
        // plan: packet.plan,
        review: packet.review,
        verdict,
        notes,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
