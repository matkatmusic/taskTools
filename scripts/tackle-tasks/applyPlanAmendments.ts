// CLI for "script applies codex amendments to the plan" (plans/diagram/pipeline.mmd).
// Reads stdin JSON, writes one line of JSON to stdout, and writes the amended plan back to
// planFilePath only on status "applied". See plans/tackle-tasks-v1_5-plan.md §4.
import { readFileSync, writeFileSync } from "node:fs";
import {
    applyPlanAmendments as applyAmendmentsToPlan,
    isPlanProblem,
    isReviewProblem,
    readAndValidatePlan,
    readAndValidateReview,
} from "./planArtifacts.ts";

export type ApplyPlanAmendmentsCliInput = {
    projectRoot: string;
    planFilePath: string;
    reviewFilePath: string;
    taskNumber: number;
};
export type ApplyPlanAmendmentsCliOutput = { status: "applied" | "rejected"; revision: number; problem: string | null };

export function runApplyPlanAmendmentsCli(input: ApplyPlanAmendmentsCliInput): ApplyPlanAmendmentsCliOutput {
    const plan = readAndValidatePlan(input.planFilePath, input.taskNumber);
    if (isPlanProblem(plan)) return { status: "rejected", revision: 0, problem: plan.problem };

    const review = readAndValidateReview(input.reviewFilePath);
    if (isReviewProblem(review)) return { status: "rejected", revision: plan.revision, problem: review.problem };
    if (review.verdict !== "amend") {
        return { status: "rejected", revision: plan.revision, problem: `review verdict is "${review.verdict}", not "amend"` };
    }

    const result = applyAmendmentsToPlan(plan, review.amendments);
    if (result.status === "rejected") return { status: "rejected", revision: plan.revision, problem: result.problem };

    writeFileSync(input.planFilePath, `${JSON.stringify(result.plan, null, 2)}\n`);
    return { status: "applied", revision: result.plan.revision, problem: null };
}

if (process.argv[1]?.endsWith("applyPlanAmendments.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as ApplyPlanAmendmentsCliInput;
    process.stdout.write(`${JSON.stringify(runApplyPlanAmendmentsCli(input))}\n`);
}
