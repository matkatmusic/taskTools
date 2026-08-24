// AUTO_GENERATE_DOCS, from pipeline-documentGeneration.mmd — ported from tackle-tasks/generateTaskDocs.ts.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { configureGeneratedArtifactIsolation, writeTaskBriefToDisk } from "../../tackle-tasks/writeTaskBrief.ts";
import type { DocsPacket } from "./WORKTREE_DOCS_MODE_INPUT.ts";

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as DocsPacket;
    configureGeneratedArtifactIsolation(packet.taskNumber, packet.worktree);
    const briefFile = writeTaskBriefToDisk(packet.taskNumber, packet.worktree, packet.projectRoot);
    return { ...packet, box: "AUTO_GENERATE_DOCS", scriptSignal: SCRIPT_SIGNAL.CONTINUE, briefFile };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
