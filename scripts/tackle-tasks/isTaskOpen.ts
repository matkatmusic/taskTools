// "is task open?" — pipeline.mmd. Presence in both files means a close crashed mid-write
// (closeTasks writes completedTasks.json before tasks.json); that is closeInProgress,
// never ordinary open [a3 28].
import { readFileSync } from "node:fs";
import { readTaskLists } from "../getTaskDetails.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type IsTaskOpenOutput = { open: boolean; closeInProgress: boolean };

export function isTaskOpen(taskNumber: number, projectRoot: string): IsTaskOpenOutput {
    requireAbsolutePath("projectRoot", projectRoot);
    const { openTasks, completedTasks } = readTaskLists(projectRoot);
    const inOpen = openTasks.some((task) => task.taskNumber === taskNumber);
    const inCompleted = completedTasks.some((task) => task.taskNumber === taskNumber);
    if (inOpen && inCompleted) return { open: false, closeInProgress: true };
    return { open: inOpen, closeInProgress: false };
}

if (process.argv[1]?.endsWith("isTaskOpen.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as { taskNumber: number; projectRoot: string };
    const output = isTaskOpen(input.taskNumber, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
