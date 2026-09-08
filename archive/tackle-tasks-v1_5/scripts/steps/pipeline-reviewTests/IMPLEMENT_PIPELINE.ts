// IMPLEMENT_PIPELINE, from pipeline-reviewTests.mmd. Hands off to pipeline-implement.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { ReviewTestsCorePacket } from "./GREEN_IMPLEMENTATION_INPUT.ts";

type IncomingPacket = ReviewTestsCorePacket & { box: string; scriptSignal: string; amended: boolean };

// maxFixRounds was always this fallback pre-migration too (scripts/tackle-tasks/AgentPromptEmitter.ts:193).
const DEFAULT_MAX_FIX_ROUNDS = 3;

export function main(input: string): Record<string, unknown> {
    const { box: _box, scriptSignal: _scriptSignal, amended: _amended, ...core } = JSON.parse(input) as IncomingPacket;
    return { box: "IMPLEMENT_PIPELINE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, ...core, maxFixRounds: DEFAULT_MAX_FIX_ROUNDS };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
