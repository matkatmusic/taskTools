// "is task number valid?" — pipeline.mmd. Presence in tasks.json and/or completedTasks.json.
import { readFileSync } from "node:fs";
import { readTaskLists } from "../getTaskDetails.ts";

export type TaskNumberLocation = "open" | "completed" | "both" | null;

export type IsTaskNumberValidOutput = { valid: boolean; location: TaskNumberLocation };

export function isTaskNumberValid(taskNumber: number, projectRoot: string): IsTaskNumberValidOutput {
    const { openTasks, completedTasks } = readTaskLists(projectRoot);
    const inOpen = openTasks.some((task) => task.taskNumber === taskNumber);
    const inCompleted = completedTasks.some((task) => task.taskNumber === taskNumber);
    if (inOpen && inCompleted) return { valid: true, location: "both" };
    if (inOpen) return { valid: true, location: "open" };
    if (inCompleted) return { valid: true, location: "completed" };
    return { valid: false, location: null };
}

if (process.argv[1]?.endsWith("isTaskNumberValid.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as { taskNumber: number; projectRoot: string };
    const output = isTaskNumberValid(input.taskNumber, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
