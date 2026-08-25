// PLANNER_RETURNED_CLARIFY, from pipeline-plan.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type Input = {
    taskNumber: number;
    runId: string;
    worktree: string;
    sourceBranch: string;
    projectRoot: string;
    // Carried by WHAT_DID_THE_PLANNER_RETURN's output; the CLARIFY branch has no plan yet, so it stops here.
    plan: unknown;
    clarifyRequest: string;
};

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as Input;
    return {
        box: "PLANNER_RETURNED_CLARIFY",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        worktree: parsed.worktree,
        sourceBranch: parsed.sourceBranch,
        projectRoot: parsed.projectRoot,
        clarifyRequest: parsed.clarifyRequest,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
