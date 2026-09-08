// REPORT_ONLY_EXIT, from pipeline-reportOnlyExit.mmd. Merged from the archive's EXIT_TYPE_NOTE_NO_WRITE_INPUT + REPORT_EXIT_TYPE_NO_WRITE: report only, write nothing.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    return { ...packet, box: "REPORT_ONLY_EXIT", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
