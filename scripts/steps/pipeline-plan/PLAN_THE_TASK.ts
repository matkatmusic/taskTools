// PLAN_THE_TASK, from pipeline-plan.mmd returns_a_prompt: builds the planner agent's prompt from PlannerBodyEmitter.ts's old planPrompt().
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { loadPreparedTask } from "../../tackle-tasks/preparedTask.ts";
import { planPrompt } from "../../tackle-tasks/planPrompt.ts";

type Input = {
    taskNumber: number;
    runId: string;
    worktree: string;
    sourceBranch: string;
    projectRoot: string;
};

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as Input;
    const prepared = loadPreparedTask(parsed.taskNumber, parsed.worktree, parsed.projectRoot);
    // Codex always reviews the plan next (see REVIEW_PLAN_PIPELINE in pipeline-plan.mmd).
    const prompt = `${planPrompt(prepared)}\nCodex reviews this plan before it is implemented.`;
    return { box: "PLAN_THE_TASK", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
