// SUITE_PIPELINE, from pipeline-rebase.mmd. Cross-diagram exit box into pipeline-suite.mmd unchanged.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { RebasePacket } from "./packet.ts";

type IncomingPacket = RebasePacket & { next?: string };

export function main(input: string): RebasePacket {
    const { next: _next, ...packet } = JSON.parse(input) as IncomingPacket;
    return { ...packet, box: "SUITE_PIPELINE", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
