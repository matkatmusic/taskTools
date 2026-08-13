// CLI for "validate the codex review and read its verdict" (plans/diagram/pipeline.mmd).
// Reads stdin JSON, writes one line of JSON to stdout. See plans/tackle-tasks-v1_5-plan.md §4.
import { readFileSync } from "node:fs";
import { isReviewProblem, readAndValidateReview } from "./planArtifacts.ts";

export type ValidateCodexReviewInput = { projectRoot: string; reviewFilePath: string };
export type ValidateCodexReviewOutput = {
    valid: boolean;
    problem: string | null;
    verdict: "amend" | "scrap" | null;
    scrapNotes: string | null;
};

export function validateCodexReview(input: ValidateCodexReviewInput): ValidateCodexReviewOutput {
    const result = readAndValidateReview(input.reviewFilePath);
    if (isReviewProblem(result)) return { valid: false, problem: result.problem, verdict: null, scrapNotes: null };
    return {
        valid: true,
        problem: null,
        verdict: result.verdict,
        scrapNotes: result.verdict === "scrap" ? result.notes : null,
    };
}

if (process.argv[1]?.endsWith("validateCodexReview.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as ValidateCodexReviewInput;
    process.stdout.write(`${JSON.stringify(validateCodexReview(input))}\n`);
}
