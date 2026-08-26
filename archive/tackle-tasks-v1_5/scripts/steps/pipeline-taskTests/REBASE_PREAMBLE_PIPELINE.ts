// REBASE_PREAMBLE_PIPELINE, from pipeline-taskTests.mmd. Forwards the task identity to pipeline-rebasePreamble.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readPacket } from "./packet.ts";

export function main(input: string): Record<string, unknown> {
    return { ...readPacket(input), box: "REBASE_PREAMBLE_PIPELINE", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
