// DOCUMENT_GENERATION, from pipeline-preambleStatusCheck.mmd. "write the task brief". One successor, so no next.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { configureGeneratedArtifactIsolation, writeTaskBriefToDisk } from "../shared/writeTaskBrief.ts";
import type { EntryPacket } from "./_packet.ts";

const KNOWN_DOCS_MODES = ["AUTOGEN", "UPDATE"];

export function main(input: string): EntryPacket {
    // Both senders decide; this box does not, so it drops their next.
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    if (!KNOWN_DOCS_MODES.includes(packet.docsMode)) {
        throw new Error(`unknown docs mode ${JSON.stringify(packet.docsMode)}`);
    }
    // AUTOGEN and UPDATE ran the same two calls before; the brief re-reads tasks.json, so a clarifyRequest lands.
    configureGeneratedArtifactIsolation(packet.taskNumber, packet.worktree);
    writeTaskBriefToDisk(packet.taskNumber, packet.worktree, packet.projectRoot);
    return { ...packet, box: "DOCUMENT_GENERATION", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
