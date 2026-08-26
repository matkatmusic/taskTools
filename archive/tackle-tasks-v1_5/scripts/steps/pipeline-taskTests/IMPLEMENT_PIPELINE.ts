// IMPLEMENT_PIPELINE, from pipeline-taskTests.mmd. Forwards the packet to reimplement against the amended entry.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readPacket } from "./packet.ts";

// maxFixRounds was always this fallback pre-migration too (scripts/tackle-tasks/AgentPromptEmitter.ts:193).
const DEFAULT_MAX_FIX_ROUNDS = 3;

export function main(input: string): Record<string, unknown> {
    const packet = readPacket(input);
    return { ...packet, box: "IMPLEMENT_PIPELINE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, maxFixRounds: DEFAULT_MAX_FIX_ROUNDS };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
