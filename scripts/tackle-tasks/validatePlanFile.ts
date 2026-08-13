// CLI for "validate the plan file" (plans/diagram/pipeline.mmd). Reads stdin JSON, writes
// one line of JSON to stdout. See plans/tackle-tasks-v1_5-plan.md §4.
import { readFileSync } from "node:fs";
import { isPlanProblem, readAndValidatePlan } from "./planArtifacts.ts";

export type ValidatePlanFileInput = { projectRoot: string; planFilePath: string; taskNumber: number };
export type ValidatePlanFileOutput = { valid: boolean; problem: string | null; sectionIds: string[] };

export function validatePlanFile(input: ValidatePlanFileInput): ValidatePlanFileOutput {
    const result = readAndValidatePlan(input.planFilePath, input.taskNumber);
    if (isPlanProblem(result)) return { valid: false, problem: result.problem, sectionIds: [] };
    return { valid: true, problem: null, sectionIds: result.sections.map((section) => section.id) };
}

if (process.argv[1]?.endsWith("validatePlanFile.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as ValidatePlanFileInput;
    process.stdout.write(`${JSON.stringify(validatePlanFile(input))}\n`);
}
