// PREAMBLE_TASK_NUMBER_INPUT, from pipeline-preambleStatusCheck.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export function main(input: string): Record<string, unknown> {
    const { taskNumber, tasksFile } = JSON.parse(input) as { taskNumber: unknown; tasksFile: unknown };
    if (!Number.isInteger(taskNumber)) {
        throw new Error(`taskNumber must be an integer, got ${JSON.stringify(taskNumber)}`);
    }
    if (typeof tasksFile !== "string" || tasksFile === "") {
        throw new Error(`tasksFile must be a non-empty string, got ${JSON.stringify(tasksFile)}`);
    }
    return { box: "PREAMBLE_TASK_NUMBER_INPUT", scriptSignal: SCRIPT_SIGNAL.CONTINUE, taskNumber, tasksFile };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
