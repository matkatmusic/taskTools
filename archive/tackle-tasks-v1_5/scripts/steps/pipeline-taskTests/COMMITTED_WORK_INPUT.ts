// COMMITTED_WORK_INPUT, from pipeline-taskTests.mmd. Input: committed work from the implement pipeline.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readPacket } from "./packet.ts";

export function main(input: string): Record<string, unknown> {
    return { ...readPacket(input), box: "COMMITTED_WORK_INPUT", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
