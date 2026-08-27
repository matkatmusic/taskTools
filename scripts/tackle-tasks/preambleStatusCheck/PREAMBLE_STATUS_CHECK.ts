// PREAMBLE_STATUS_CHECK, from pipeline-preambleStatusCheck.mmd. "is the task number valid?"
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { taskBranchName } from "../shared/createTaskWorktree.ts";
import { isTaskNumberValid } from "../shared/isTaskNumberValid.ts";
import { taskFilesProjectRoot } from "../../taskFiles.ts";
import type { EntryPacket } from "./_packet.ts";

// The workflow's first input.
type Input = { taskNumber: number; tasksFile: string };

export function main(input: string): EntryPacket & { next: string } {
    const { taskNumber, tasksFile } = JSON.parse(input) as Input;
    const projectRoot = taskFilesProjectRoot({ tasksPath: resolve(tasksFile), completedTasksPath: "" });
    const packet: EntryPacket = {
        box: "PREAMBLE_STATUS_CHECK",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber,
        runId: "",
        projectRoot,
        worktree: "",
        branch: taskBranchName(taskNumber),
        docsMode: "",
        planFile: "",
        exitType: "",
        exitNote: "",
    };
    if (!isTaskNumberValid(taskNumber, projectRoot).valid) {
        return { ...packet, exitType: "invalid-number", exitNote: "task number is not in tasks.json", next: "pipeline-reportOnlyExit.mmd::REPORT_ONLY_EXIT" };
    }
    return { ...packet, next: "IS_TASK_BLOCKED_Q" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
