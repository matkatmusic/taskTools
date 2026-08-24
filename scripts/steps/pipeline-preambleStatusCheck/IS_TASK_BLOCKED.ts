// IS_TASK_BLOCKED, from pipeline-preambleStatusCheck.mmd
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { isTaskBlocked } from "../../tackle-tasks/isTaskBlocked.ts";
import { taskFilesProjectRoot } from "../../taskFiles.ts";

export function main(input: string): Record<string, unknown> {
    const { taskNumber, tasksFile } = JSON.parse(input) as { taskNumber: number; tasksFile: string };
    const projectRoot = taskFilesProjectRoot({ tasksPath: resolve(tasksFile), completedTasksPath: "" });
    const { blocked } = isTaskBlocked(taskNumber, projectRoot);
    if (blocked) {
        return {
            box: "IS_TASK_BLOCKED", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "REPORT_ONLY_EXIT",
            taskNumber, tasksFile, exitType: "blocked", note: "an open blocker remains",
        };
    }
    return {
        box: "IS_TASK_BLOCKED", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "IS_TASK_ACTIVE",
        taskNumber, tasksFile, exitType: "", note: "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
