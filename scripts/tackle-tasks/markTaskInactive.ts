// "mark task inactive in tasks.json" — pipeline.mmd, both chains.
import { readFileSync } from "node:fs";
import { endTaskRun } from "./taskRunState.ts";

export type MarkTaskInactiveInput = { taskNumber: number; projectRoot: string };
export type MarkTaskInactiveOutput = { active: false; endedAt: string };

export function markTaskInactive(input: MarkTaskInactiveInput): MarkTaskInactiveOutput {
    const state = endTaskRun(input.taskNumber, input.projectRoot);
    const current = state.history[state.history.length - 1];
    return { active: false, endedAt: current.endedAt as string };
}

if (process.argv[1]?.endsWith("markTaskInactive.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as MarkTaskInactiveInput;
    const output = markTaskInactive(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
