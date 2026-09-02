// PLAN_THE_TASK, from _pipeline-monolith.mmd returns_a_prompt. Same body as pipeline-plan's; only the input shape changed.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { loadPreparedTask } from "../shared/preparedTask.ts";
import type { PreparedTask } from "../shared/preparedTask.ts";
import { planPrompt } from "../shared/planPrompt.ts";
import { spawnAgentHeader } from "../shared/spawnAgentCli.ts";
import { whatToReturnSection } from "../shared/whatToReturn.ts";
// import { spawnClaudeCliPrompt } from "../shared/spawnAgentCli.ts"; // retired: the agent follows the prompt itself, no CLI spawn.
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";

// Beside the run-log, so `tail -f` on it shows the spawned agent working. The hook sets RUN_STEP_LOG for every block.
// const agentLogFile = () => process.env.RUN_STEP_LOG!.replace(/-run-log\.md$/, "-agents.log");

// Difficulty 7+: an agent spawns codex to draft the plan, same shell-spawn pattern CodexReviewBodyEmitter.ts uses.
function codexPlanPrompt(t: PreparedTask): string {
    const root = t.repoRoot.replace(/\/+$/, "");
    const answerFile = `${root}/plans/PLAN_THE_TASK.codex-answer.md`;
    return `${spawnAgentHeader("plan", true)}

\`\`\`\`sh
PLAN_PROMPT=$(cat <<'PLANEOF'
${planPrompt(t)}
PLANEOF
)
cd ${root} && codex exec -s workspace-write -m gpt-5.6-terra -c 'model_reasoning_effort="high"' "$PLAN_PROMPT" </dev/null >${answerFile}
\`\`\`\`

${whatToReturnSection(`{ "outcome": "<PLAN if ${t.planFile} now exists, else CLARIFY>", "planFile": "${t.planFile}", "clarifyRequest": "<empty when outcome is PLAN; otherwise the question from ${answerFile}>" }`, `checking whether ${t.planFile} exists and reading ${answerFile} for the clarify question`, "")}
`;
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    const prepared = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    const entry = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find((task) => task.taskNumber === packet.taskNumber);
    if (entry === undefined) throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
    const promptFile = `${prepared.repoRoot.replace(/\/+$/, "")}/plans/PLAN_THE_TASK.prompt.md`;
    mkdirSync(dirname(promptFile), { recursive: true });
    const body = Number(entry.difficulty) >= 7
        ? codexPlanPrompt(prepared)
        : `${planPrompt(prepared)}\nCodex reviews this plan before it is implemented.`;
    writeFileSync(promptFile, body);
    // const prompt = spawnClaudeCliPrompt(...): retired, the workflow agent reads the prompt file and follows it.
    const prompt = `invoke '/read-file "${promptFile}"' and follow the instructions.`;
    return { box: "PLAN_THE_TASK", scriptSignal: SCRIPT_SIGNAL.PROMPT, prompt };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
