// RECORD_MODIFIED_FILES_SUCCESS, from pipeline-mergeSucceededExit.mmd. Mutating: records modified files to tasks.json.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { recordTaskModifiedFiles } from "../../tackle-tasks/recordTaskModifiedFiles.ts";

export type RecordModifiedFilesSuccessInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
    worktreePath: string;
    rootSourceBranch: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as RecordModifiedFilesSuccessInput;
    recordTaskModifiedFiles({
        taskNumber: packet.taskNumber, runId: packet.runId, projectRoot: packet.projectRoot,
        worktree: packet.worktreePath, sourceBranch: packet.rootSourceBranch,
    });
    return {
        box: "RECORD_MODIFIED_FILES_SUCCESS", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId, worktreePath: packet.worktreePath,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
