// STOP, from pipeline-mergeSucceededExit.mmd
// Ends the walk. Exit type: completed.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type StopInput = {
    box: string;
    scriptSignal: string;
    taskNumber: number;
    closureNote: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as StopInput;
    return { box: "STOP", scriptSignal: SCRIPT_SIGNAL.STOP, taskNumber: packet.taskNumber, closureNote: packet.closureNote };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
