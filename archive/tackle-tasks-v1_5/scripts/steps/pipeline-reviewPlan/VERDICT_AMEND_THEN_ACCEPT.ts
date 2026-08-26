// VERDICT_AMEND_THEN_ACCEPT, from pipeline-reviewPlan.mmd. Ported from scripts/tackle-tasks/recordPlanReview.ts.  Mutating: writes codex's fixes straight into the plan file, so implement reads them.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { writeJsonAtomically } from "../../taskStateLock.ts";
import type { PlanReview } from "../../tackle-tasks/recordPlanReview.ts";

export type VerdictAmendThenAcceptPacket = {
    taskNumber: number;
    taskStateRoot: string;
    repoRoot: string;
    planFile: string;
    runId: string;
    sourceBranch: string;
    // plan: unknown;
    // review: PlanReview;
    reviewOutputFile: string;
};

const fixNote = (fix: PlanReview["fixes"][number]) => `${fix.fix}\n\nDurable because: ${fix.durableBecause}`;

function applyFixesToPlan(planFile: string, review: PlanReview): void {
    if (review.outcome === "ERROR") throw new Error("VERDICT_AMEND_THEN_ACCEPT: review has outcome ERROR, no fixes to apply");
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    for (const fix of review.fixes) {
        const section = plan.sections.find((entry: { id: string }) => entry.id === fix.sectionId);
        if (!section) throw new Error(`review fix names section "${fix.sectionId}", which the plan does not have`);
        section.codexNotes = fixNote(fix);
    }
    plan.revision += 1;
    writeJsonAtomically(planFile, plan);
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as VerdictAmendThenAcceptPacket;
    const review = JSON.parse(readFileSync(packet.reviewOutputFile, "utf8")) as PlanReview;
    applyFixesToPlan(packet.planFile, review);
    return {
        box: "VERDICT_AMEND_THEN_ACCEPT",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        taskStateRoot: packet.taskStateRoot,
        repoRoot: packet.repoRoot,
        planFile: packet.planFile,
        runId: packet.runId,
        sourceBranch: packet.sourceBranch,
        // plan: packet.plan,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
