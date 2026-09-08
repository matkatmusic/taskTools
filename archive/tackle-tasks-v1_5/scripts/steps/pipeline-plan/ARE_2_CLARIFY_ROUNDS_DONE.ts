// ARE_2_CLARIFY_ROUNDS_DONE, from pipeline-plan.mmd
// decision, read-only: CLARIFY is capped at 2 rounds, counted within this run only.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { getAttemptCount, MAX_ATTEMPTS } from "../../tackle-tasks/taskRunState.ts";

type Input = {
    taskNumber: number;
    runId: string;
    worktree: string;
    sourceBranch: string;
    projectRoot: string;
    clarifyRequest: string;
};

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as Input;
    const roundsDone = getAttemptCount(parsed.taskNumber, "clarify", parsed.projectRoot) >= MAX_ATTEMPTS;
    return {
        box: "ARE_2_CLARIFY_ROUNDS_DONE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        worktree: parsed.worktree,
        sourceBranch: parsed.sourceBranch,
        projectRoot: parsed.projectRoot,
        clarifyRequest: parsed.clarifyRequest,
        exitType: roundsDone ? "clarify-stuck" : "",
        exitNote: roundsDone ? "the planner asked twice for something the docs cannot supply. worktree preserved." : "",
        next: roundsDone ? "EXIT_WORKFLOW_PLAN" : "WRITE_CLARIFY_REQUEST",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
