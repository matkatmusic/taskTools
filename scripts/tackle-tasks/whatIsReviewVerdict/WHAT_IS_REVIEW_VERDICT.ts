// WHAT_IS_REVIEW_VERDICT, from pipeline-reviewPlan.mmd. Ruling ported from recordPlanReview.ts; applies AMEND_THEN_ACCEPT fixes to the plan.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";
import { efficacyPercentage, rulingByFixCount, rulingByPercentage } from "../../planReviewRuling.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";
import type { WhatIsReviewVerdictPacket } from "./_packet.ts";

type Input = EntryPacket & { message: string; additionalData: { reviewFile: string } };

type PlanReviewFix = { sectionId: string; fix: string; durableBecause: string };
type PlanReview = { outcome: "OK" | "ERROR"; missingFiles: string[]; message: string; fixes: PlanReviewFix[] };

// Below this, absolute fix counts decide the ruling; at or above it, the efficacy percentage does.
const PERCENTAGE_SCALE_MINIMUM_SECTIONS = 12;

// Ruling order is best to worst, so a Ruling indexes this directly.
const VERDICTS = ["ACCEPT", "AMEND_THEN_ACCEPT", "AMEND", "SCRAP"] as const;

const fixNote = (fix: PlanReviewFix) => `${fix.fix}\n\nDurable because: ${fix.durableBecause}`;

function decideVerdict(planFile: string, review: PlanReview): { verdict: string; notes: string } {
    // The reviewer never saw the plan, so ERROR is reported as the verdict rather than ruled on.
    if (review.outcome === "ERROR") {
        return { verdict: "ERROR", notes: `${review.message} missing: ${review.missingFiles.join(", ")}` };
    }
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    const fixes = review.fixes;
    const sectionCount = plan.sections.length;
    const ruling = sectionCount >= PERCENTAGE_SCALE_MINIMUM_SECTIONS
        ? rulingByPercentage(efficacyPercentage(sectionCount, fixes.length))
        : rulingByFixCount(fixes.length);
    const notes = fixes.map((fix: PlanReviewFix) => `[${fix.sectionId}] ${fixNote(fix)}`).join("\n\n");
    return { verdict: VERDICTS[ruling]!, notes };
}

// Writes codex's fixes straight into the plan file, so implement reads them.
function applyFixesToPlan(planFile: string, fixes: PlanReviewFix[]): void {
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    let changed = false;
    for (const fix of fixes) {
        const section = plan.sections.find((entry: { id: string }) => entry.id === fix.sectionId);
        if (!section) throw new Error(`review fix names section "${fix.sectionId}", which the plan does not have`);
        const notes = fixNote(fix);
        if (section.codexNotes !== notes) changed = true;
        section.codexNotes = notes;
    }
    if (!changed) return;
    plan.revision += 1;
    writeJsonAtomically(planFile, plan);
}

export function main(input: string): Record<string, unknown> {
    const { message: _message, additionalData, ...rest } = JSON.parse(input) as Input;
    const packet: WhatIsReviewVerdictPacket = { ...rest, reviewOutputFile: additionalData.reviewFile };
    const review = JSON.parse(readFileSync(packet.reviewOutputFile, "utf8")) as PlanReview;
    const { verdict, notes } = decideVerdict(packet.planFile, review);
    const output = { ...packet, box: "WHAT_IS_REVIEW_VERDICT", scriptSignal: SCRIPT_SIGNAL.CONTINUE, verdict, notes };

    if (verdict === "ERROR") {
        return {
            ...output, exitType: "run-failed", exitNote: notes || "the plan review could not run",
            next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
        };
    }
    if (verdict === "ACCEPT" || verdict === "AMEND_THEN_ACCEPT") {
        if (verdict === "AMEND_THEN_ACCEPT") applyFixesToPlan(packet.planFile, review.fixes);
        return { ...output, next: "pipeline-implementTask.mmd::IMPLEMENT_TASK" };
    }
    return { ...output, next: "UPDATE_TASKS_JSON" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
