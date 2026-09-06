// READ_FAILURES_PUBLICATION_STATE, from pipeline-failuresExit.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { readPublicationState } from "../shared/readPublicationState.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): Record<string, unknown> {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const { state } = readPublicationState({
        taskNumber: packet.taskNumber, projectRoot: packet.projectRoot, worktreePath: packet.worktree,
        rootSourceBranch: "staging",
    });
    return { ...packet, box: "READ_FAILURES_PUBLICATION_STATE", scriptSignal: SCRIPT_SIGNAL.CONTINUE, publicationState: state };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
