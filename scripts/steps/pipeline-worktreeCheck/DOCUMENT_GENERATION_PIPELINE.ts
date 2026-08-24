// DOCUMENT_GENERATION_PIPELINE, from pipeline-worktreeCheck.mmd. Hand-off to pipeline-documentGeneration.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { WorktreeCheckPacket } from "./_packet.ts";

export function main(input: string): WorktreeCheckPacket & { clarifyRequest: string } {
    const packet = JSON.parse(input) as WorktreeCheckPacket;
    return { ...packet, box: "DOCUMENT_GENERATION_PIPELINE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, clarifyRequest: "" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "{}")));
