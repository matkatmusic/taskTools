// ARCHIVE_TASK, from pipeline-mergeSucceededExit.mmd
// "move task to completedTasks.json and update tasks blocked by it". Mutating.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { closeTaskRun } from "../../tackle-tasks/closeTaskRun.ts";

const STEP_ID = "merge-succeeded-exit";

export type ArchiveTaskInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
    closureNote: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as ArchiveTaskInput;
    const result = closeTaskRun({
        taskNumber: packet.taskNumber, runId: packet.runId, projectRoot: packet.projectRoot,
        closureNote: packet.closureNote, stepId: STEP_ID,
    });
    if (!result.closed.includes(packet.taskNumber)) {
        throw new Error(
            `ARCHIVE_TASK: task ${packet.taskNumber} was not archived `
            + `(skipped: ${JSON.stringify(result.skipped)}, ambiguous: ${JSON.stringify(result.ambiguous)})`,
        );
    }
    return { box: "ARCHIVE_TASK", scriptSignal: SCRIPT_SIGNAL.CONTINUE, taskNumber: packet.taskNumber, closureNote: packet.closureNote };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
