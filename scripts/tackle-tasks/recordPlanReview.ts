// "update tasks.json entry" — pipeline-reviewPlan.mmd. Rules on codex's review and writes it where its next reader looks.
import { readFileSync } from "node:fs";
import { efficacyPercentage, Ruling, rulingByFixCount, rulingByPercentage } from "../planReviewRuling.ts";
import { readTaskFile, resolveTaskFiles } from "../taskFiles.ts";
import { requireAbsolutePath } from "./inputPaths.ts";
import { withTaskStateLock, writeJsonAtomically } from "../taskStateLock.ts";

// Below this, absolute fix counts decide the ruling; at or above it, the efficacy percentage does.
const PERCENTAGE_SCALE_MINIMUM_SECTIONS = 12;

export type PlanReviewFix = { sectionId: string; fix: string; durableBecause: string };
// One shape, enforced by plans/review-plan-schema.json, so outcome is always present.
export type PlanReview = {
    outcome: "OK" | "ERROR";
    missingFiles: string[];
    message: string;
    issues: unknown[];
    fixes: PlanReviewFix[];
    sectionsThatHoldUp: unknown[];
};

export type RecordPlanReviewInput = {
    projectRoot: string;
    planFilePath: string;
    taskNumber: number;
    review: PlanReview;
};
export type RecordPlanReviewOutput = { verdict: string; notes: string };

// Ruling order is best to worst, so a Ruling indexes this directly.
const VERDICTS = ["ACCEPT", "AMEND_THEN_ACCEPT", "AMEND", "SCRAP"] as const;

const fixNote = (fix: PlanReviewFix) => `${fix.fix}\n\nDurable because: ${fix.durableBecause}`;

export function recordPlanReview(input: RecordPlanReviewInput): RecordPlanReviewOutput {
    const projectRoot = requireAbsolutePath("projectRoot", input.projectRoot);
    const planFilePath = requireAbsolutePath("planFilePath", input.planFilePath);
    const review = input.review;
    // The reviewer never saw the plan, so ERROR is reported as the verdict rather than ruled on.
    if (review.outcome === "ERROR") {
        return { verdict: "ERROR", notes: `${review.message} missing: ${review.missingFiles.join(", ")}` };
    }
    const plan = JSON.parse(readFileSync(planFilePath, "utf8"));
    const fixes = review.fixes;
    const sectionCount = plan.sections.length;
    const ruling = sectionCount >= PERCENTAGE_SCALE_MINIMUM_SECTIONS
        ? rulingByPercentage(efficacyPercentage(sectionCount, fixes.length))
        : rulingByFixCount(fixes.length);
    const notes = fixes.map((fix) => `[${fix.sectionId}] ${fixNote(fix)}`).join("\n\n");

    // Ruling 1 goes straight to implement, so the fixes ride on the sections the implementer reads.
    if (ruling === Ruling.APPLY_FIX_THEN_ACCEPT) {
        for (const fix of fixes) {
            const section = plan.sections.find((entry: any) => entry.id === fix.sectionId);
            if (!section) throw new Error(`review fix names section "${fix.sectionId}", which the plan does not have`);
            section.codexNotes = fixNote(fix);
        }
        plan.revision += 1;
        writeJsonAtomically(planFilePath, plan);
    }

    // Rulings 2 and 3 replan, and the planner reads the task entry, so the notes go there.
    if (ruling === Ruling.APPLY_FIX_THEN_REREVIEW || ruling === Ruling.REWRITE_THEN_REVIEW) {
        const pair = resolveTaskFiles(projectRoot);
        withTaskStateLock(pair.tasksPath, () => {
            const tasks = readTaskFile(pair.tasksPath);
            const entry = tasks.find((task: any) => task.taskNumber === input.taskNumber);
            if (!entry) throw new Error(`task ${input.taskNumber} not found in ${pair.tasksPath}`);
            (entry as any).codexReviewNotes = notes;
            writeJsonAtomically(pair.tasksPath, tasks);
        });
    }

    return { verdict: VERDICTS[ruling], notes };
}

if (process.argv[1]?.endsWith("recordPlanReview.ts")) {
    const [projectRoot, planFilePath, taskNumber] = process.argv.slice(2);
    const review = JSON.parse(readFileSync(0, "utf8")) as PlanReview;
    const output = recordPlanReview({ projectRoot, planFilePath, taskNumber: Number(taskNumber), review });
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
