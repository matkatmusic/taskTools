// IS_TASK_ACTIVE, from pipeline-preambleStatusCheck.mmd
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskRunState } from "../../tackle-tasks/taskRunState.ts";
import { taskFilesProjectRoot } from "../../taskFiles.ts";

export function main(input: string): Record<string, unknown> {
    const { taskNumber, tasksFile } = JSON.parse(input) as { taskNumber: number; tasksFile: string };
    const projectRoot = taskFilesProjectRoot({ tasksPath: resolve(tasksFile), completedTasksPath: "" });
    const { active } = readTaskRunState(taskNumber, projectRoot);
    if (active) {
        return {
            box: "IS_TASK_ACTIVE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "REPORT_ONLY_EXIT",
            taskNumber, tasksFile, exitType: "already-active", note: "a previous run left the task active",
        };
    }
    return {
        box: "IS_TASK_ACTIVE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "MARK_TASK_ACTIVE",
        taskNumber, tasksFile, exitType: "", note: "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
