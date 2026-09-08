// WRITE_EXIT_TYPE_AND_NOTE, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { writeTaskExitNotes } from "../shared/writeTaskExitNotes.ts";
import type { EntryPacket } from "./_packet.ts";

// No work landed: write the incoming exit type and note as-is.
export function main(input: string): Record<string, unknown> {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    writeTaskExitNotes({ taskNumber: packet.taskNumber, runId: packet.runId, projectRoot: packet.projectRoot, exitType: packet.exitType, exitNote: packet.exitNote });
    return { ...packet, box: "WRITE_EXIT_TYPE_AND_NOTE", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
