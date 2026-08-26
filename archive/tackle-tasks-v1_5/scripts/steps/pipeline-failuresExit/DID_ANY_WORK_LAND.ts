// DID_ANY_WORK_LAND, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { FailuresExitEntryInput } from "./EXIT_TYPE_NOTE_INPUT.ts";
import type { PublicationState } from "../../tackle-tasks/readPublicationState.ts";

type Input = FailuresExitEntryInput & { publicationState: PublicationState };

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const next = packet.publicationState === "NONE LANDED" ? "WRITE_EXIT_TYPE_AND_NOTE" : "WRITE_PUBLICATION_OUTCOME";
    return { ...packet, box: "DID_ANY_WORK_LAND", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
