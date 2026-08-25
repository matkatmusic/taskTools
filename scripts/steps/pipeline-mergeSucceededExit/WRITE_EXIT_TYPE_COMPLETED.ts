// WRITE_EXIT_TYPE_COMPLETED, from pipeline-mergeSucceededExit.mmd. Runs first, before any release: the point of no return.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { writeTaskExitNotes } from "../../tackle-tasks/writeTaskExitNotes.ts";

export type WriteExitTypeCompletedInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
    worktreePath: string;
    rootSourceBranch: string;
    exitNote: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as WriteExitTypeCompletedInput;
    writeTaskExitNotes({
        taskNumber: packet.taskNumber, runId: packet.runId, projectRoot: packet.projectRoot,
        exitType: "completed", exitNote: packet.exitNote,
    });
    return {
        box: "WRITE_EXIT_TYPE_COMPLETED", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId,
        worktreePath: packet.worktreePath, rootSourceBranch: packet.rootSourceBranch,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
