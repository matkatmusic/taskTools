// ACTIVE_TASK_INPUT, from pipeline-worktreeCheck.mmd. Input: { taskNumber, worktree path }.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { taskBranchName } from "../../tackle-tasks/createTaskWorktree.ts";
import { taskFilesProjectRoot } from "../../taskFiles.ts";
import type { WorktreeCheckPacket } from "./_packet.ts";

export type ActiveTaskInput = { taskNumber: number; tasksFile: string; runId: string };

export function main(input: string): WorktreeCheckPacket {
    const parsed = JSON.parse(input) as ActiveTaskInput;
    return {
        box: "ACTIVE_TASK_INPUT",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        projectRoot: taskFilesProjectRoot({ tasksPath: resolve(parsed.tasksFile), completedTasksPath: "" }),
        worktree: "",
        branch: taskBranchName(parsed.taskNumber),
        docsMode: "",
        exitType: "",
        exitNote: "",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "{}")));
