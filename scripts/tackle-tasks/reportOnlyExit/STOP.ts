// STOP, shared by pipeline-reportOnlyExit.mmd, pipeline-failuresExit.mmd, and pipeline-mergeSucceededExit.mmd. Ends the walk.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as EntryPacket;
    return { ...packet, box: "STOP", scriptSignal: SCRIPT_SIGNAL.STOP };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
