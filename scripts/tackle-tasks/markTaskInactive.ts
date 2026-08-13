// "mark task inactive in tasks.json" — pipeline.mmd, both chains.
import { readFileSync } from "node:fs";
import { endTaskRun } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type MarkTaskInactiveInput = { taskNumber: number; runId: string; projectRoot: string };
export type MarkTaskInactiveOutput = { active: false; endedAt: string };

export function markTaskInactive(input: MarkTaskInactiveInput): MarkTaskInactiveOutput {
    requireAbsolutePath("projectRoot", input.projectRoot);
    const state = endTaskRun(input.taskNumber, input.runId, input.projectRoot);
    const current = state.history[state.history.length - 1];
    return { active: false, endedAt: current.endedAt as string };
}

if (process.argv[1]?.endsWith("markTaskInactive.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as MarkTaskInactiveInput;
    const output = markTaskInactive(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
