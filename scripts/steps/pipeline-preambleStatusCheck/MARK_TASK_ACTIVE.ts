// MARK_TASK_ACTIVE, from pipeline-preambleStatusCheck.mmd
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { claimTask } from "../../tackle-tasks/taskRunState.ts";
import { taskFilesProjectRoot } from "../../taskFiles.ts";

// "is the task active?" and "mark it active" are one atomic write; claimTask does both.
export function main(input: string): Record<string, unknown> {
    const { taskNumber, tasksFile } = JSON.parse(input) as { taskNumber: number; tasksFile: string };
    const projectRoot = taskFilesProjectRoot({ tasksPath: resolve(tasksFile), completedTasksPath: "" });
    const runId = randomUUID();
    const outcome = claimTask(taskNumber, runId, projectRoot);
    if (outcome.status !== "claimed") {
        throw new Error(`task ${taskNumber} could not be marked active: ${outcome.status}`);
    }
    return { box: "MARK_TASK_ACTIVE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, taskNumber, tasksFile, runId };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
