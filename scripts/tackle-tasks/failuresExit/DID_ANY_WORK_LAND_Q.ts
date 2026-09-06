// DID_ANY_WORK_LAND_Q, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    if (packet.publicationState === "NONE LANDED") {
        return { ...packet, box: "DID_ANY_WORK_LAND_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "WRITE_EXIT_TYPE_AND_NOTE" };
    }
    return { ...packet, box: "DID_ANY_WORK_LAND_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "WRITE_PUBLICATION_OUTCOME" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
