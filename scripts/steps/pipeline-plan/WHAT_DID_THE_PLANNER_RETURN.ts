// WHAT_DID_THE_PLANNER_RETURN, from pipeline-plan.mmd decision, read-only: routes on the planner agent's returned outcome.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type Input = {
    taskNumber: number;
    runId: string;
    worktree: string;
    sourceBranch: string;
    projectRoot: string;
    outcome: "PLAN" | "CLARIFY";
    plan: unknown;
    clarifyRequest: string | null;
};

const NEXT_BY_OUTCOME: Record<Input["outcome"], string> = {
    PLAN: "PLANNER_RETURNED_PLAN",
    CLARIFY: "PLANNER_RETURNED_CLARIFY",
};

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as Input;
    const next = NEXT_BY_OUTCOME[parsed.outcome];
    if (next === undefined) throw new Error(`unknown planner outcome: ${JSON.stringify(parsed.outcome)}`);
    return {
        box: "WHAT_DID_THE_PLANNER_RETURN",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        worktree: parsed.worktree,
        sourceBranch: parsed.sourceBranch,
        projectRoot: parsed.projectRoot,
        plan: parsed.plan,
        clarifyRequest: parsed.clarifyRequest,
        next,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
