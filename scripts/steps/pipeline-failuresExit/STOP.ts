// STOP, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { FailuresExitEntryInput } from "./EXIT_TYPE_NOTE_INPUT.ts";
import type { PublicationState } from "../../tackle-tasks/readPublicationState.ts";

type Input = FailuresExitEntryInput & {
    publicationState: PublicationState; modifiedFiles: string[];
    leaseReleased: boolean; leaseRetained: boolean; lockReleased: boolean;
    active: boolean; endedAt: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    return { ...packet, box: "STOP", scriptSignal: SCRIPT_SIGNAL.STOP };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
