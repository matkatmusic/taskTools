import { readFileSync, writeFileSync } from "node:fs";
import { readTaskFile } from "../../shared/taskFiles.ts";
import type { AgentOptions, StepConfig } from "../generateSteps.ts";

export type AgentBand = { minDifficulty: number; model: string; effort: string };
export const DEFAULT_AGENT_BANDS: AgentBand[] = [
    { minDifficulty: 1, model: "claude-opus-4-8[1m]", effort: "high" },
    { minDifficulty: 5, model: "claude-sonnet-5[1m]", effort: "high" },
    { minDifficulty: 7, model: "claude-fable-5-1[1m]", effort: "medium" },
];
// The blocks where the agent does the work itself. Every other block, decision or codex relay, runs on RELAY_AGENT.
export const BAND_BLOCKS = new Set(["PLAN_THE_TASK", "IMPLEMENT_TASK", "FIX_IMPLEMENT_TASK_TESTS", "FIX_CONFLICTS", "FIX_THE_CODEBASE_FOR_SUITE"]);
export const RELAY_AGENT: AgentOptions = { model: "sonnet", effort: "low" };
// The fallback reviewers answer the codex question themselves, on the model their block names.
export const FALLBACK_REVIEWER_AGENTS: Record<string, AgentOptions> = {
    CODEX_REVIEW_FALLBACK_FABLE: { model: "claude-fable-5-1[1m]", effort: "medium" },
    CODEX_REVIEW_FALLBACK_OPUS: { model: "claude-opus-4-8[1m]", effort: "high" },
    CODEX_TEST_REVIEW_FALLBACK_FABLE: { model: "claude-fable-5-1[1m]", effort: "medium" },
    CODEX_TEST_REVIEW_FALLBACK_OPUS: { model: "claude-opus-4-8[1m]", effort: "high" },
};

// Sets agent per block: task override, else band for band blocks, else relay agent.
export function resolveAgentOptions(stepsConfigPath: string, tasksFile: string, taskNumber: number): void {
    const config = JSON.parse(readFileSync(stepsConfigPath, "utf8")) as StepConfig;
    const entry = readTaskFile(tasksFile).find(task => task.taskNumber === taskNumber);
    if (entry === undefined) throw new Error(`task ${taskNumber} not found in ${tasksFile}`);
    if (typeof entry.difficulty !== "number") throw new Error(`task ${taskNumber} has no difficulty; run /rate-task ${taskNumber}`);
    const difficulty = entry.difficulty;
    const overrides = (entry.agent ?? {}) as Record<string, AgentOptions>;
    const band = DEFAULT_AGENT_BANDS.filter(candidate => candidate.minDifficulty <= difficulty).at(-1)!;
    const bandAgent: AgentOptions = { model: band.model, effort: band.effort };
    for (const entries of Object.values(config)) {
        for (const step of entries) {
            step.agent = overrides[step.box] ?? FALLBACK_REVIEWER_AGENTS[step.box] ?? (BAND_BLOCKS.has(step.box) ? bandAgent : RELAY_AGENT);
        }
    }
    writeFileSync(stepsConfigPath, `${JSON.stringify(config, null, 4)}\n`);
}
