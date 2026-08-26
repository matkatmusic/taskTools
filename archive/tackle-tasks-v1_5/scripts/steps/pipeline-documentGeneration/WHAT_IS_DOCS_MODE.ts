// WHAT_IS_DOCS_MODE, from pipeline-documentGeneration.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import type { DocsPacket } from "./WORKTREE_DOCS_MODE_INPUT.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as DocsPacket;
    let next: string;
    if (packet.docsMode === "AUTOGEN") {
        next = "DOCS_MODE_AUTOGEN";
    } else if (packet.docsMode === "UPDATE") {
        next = "DOCS_MODE_UPDATE";
    } else {
        throw new Error(`unknown docs mode ${JSON.stringify(packet.docsMode)}`);
    }
    return { ...packet, box: "WHAT_IS_DOCS_MODE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
