// REBASE_PREAMBLE_PIPELINE, from pipeline-reviewTests.mmd. Hands off to pipeline-rebasePreamble.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { ReviewTestsCorePacket } from "./GREEN_IMPLEMENTATION_INPUT.ts";

type IncomingPacket = ReviewTestsCorePacket & { box: string; scriptSignal: string; next: string; notes: string };

export function main(input: string): Record<string, unknown> {
    const { box: _box, scriptSignal: _scriptSignal, next: _next, notes: _notes, ...core } = JSON.parse(input) as IncomingPacket;
    return { box: "REBASE_PREAMBLE_PIPELINE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, ...core };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
