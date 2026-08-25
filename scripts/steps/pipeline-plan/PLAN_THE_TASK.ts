// PLAN_THE_TASK, from pipeline-plan.mmd returns_a_prompt: builds the planner agent's prompt from PlannerBodyEmitter.ts's old planPrompt().
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
    const promptFile = `${prepared.repoRoot.replace(/\/+$/, "")}/plans/PLAN_THE_TASK.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, `${planPrompt(prepared)}\nCodex reviews this plan before it is implemented.`);
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { box: "PLAN_THE_TASK", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
