// REPORT_CLOSURE_NOTE, from pipeline-mergeSucceededExit.mmd "report the closure note". No mutation: hands the archived run's own closure note on to STOP.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";

export type ReportClosureNoteInput = {
    box: string;
    scriptSignal: string;
    taskNumber: number;
    closureNote: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as ReportClosureNoteInput;
    return { box: "REPORT_CLOSURE_NOTE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, taskNumber: packet.taskNumber, closureNote: packet.closureNote };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
