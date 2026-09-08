// REVIEW_PLAN_PIPELINE, from pipeline-plan.mmd goes to pipeline-reviewPlan.mmd::DRAFT_PLAN_INPUT, which re-derives the plan file itself.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type Input = {
    taskNumber: number;
    runId: string;
    worktree: string;
    sourceBranch: string;
    projectRoot: string;
    // plan: unknown;
    planFile: string;
    clarifyRequest: string | null;
};

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as Input;
    return {
        box: "REVIEW_PLAN_PIPELINE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        worktree: parsed.worktree,
        sourceBranch: parsed.sourceBranch,
        projectRoot: parsed.projectRoot,
        // plan: parsed.plan,
        planFile: parsed.planFile,
        clarifyRequest: parsed.clarifyRequest,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
