// MARK_TASK_INACTIVE_SUCCESS, from pipeline-mergeSucceededExit.mmd "mark the task inactive in tasks.json". Mutating: shared with pipeline-failuresExit.mmd's exit tail, ending the run there too.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { markTaskInactive } from "../shared/markTaskInactive.ts";

export type MarkTaskInactiveSuccessInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
    closureNote: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as MarkTaskInactiveSuccessInput;
    markTaskInactive({ taskNumber: packet.taskNumber, runId: packet.runId, projectRoot: packet.projectRoot });
    return {
        box: "MARK_TASK_INACTIVE_SUCCESS", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId, closureNote: packet.closureNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
