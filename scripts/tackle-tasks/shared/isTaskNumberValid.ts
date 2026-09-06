// "is task number valid?" — pipeline.mmd. A task is valid when it is in tasks.json. Nothing else:
// completedTasks.json holds finished work, which is not a task this skill can run.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { resolveTaskFiles } from "../../shared/taskFiles.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

// `reason` is worded here, once, so no caller has to word it again. It names the real task
// store, which is not always in the same place.
export type IsTaskNumberValidOutput = { valid: boolean; reason: string | null };

export function isTaskNumberValid(taskNumber: number, projectRoot: string): IsTaskNumberValidOutput {
    requireAbsolutePath("projectRoot", projectRoot);
    const { tasksPath } = resolveTaskFiles(projectRoot);
    const found = execFileSync("jq", [`any(.[]; .taskNumber == ${taskNumber})`, tasksPath], { encoding: "utf8" }).trim();
    if (found === "true") return { valid: true, reason: null };
    return { valid: false, reason: `not found in \`${relative(projectRoot, tasksPath)}\`` };
}

if (process.argv[1]?.endsWith("isTaskNumberValid.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as { taskNumber: number; projectRoot: string };
    process.stdout.write(`${JSON.stringify(isTaskNumberValid(input.taskNumber, input.projectRoot))}\n`);
}
