// PREVIOUS_RUN_LEFT_NOTES, from pipeline-preambleStatusCheck.mmd. "did the previous run save a notes file in the worktree?"
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { findPreviousRunNotesFile } from "../shared/isTaskRunResumable.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket & { implementationNotesFile: string; next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    // Only the YES exit of Q_RESUME_PREVIOUS_RUN_IF_POSSIBLE reaches this block, so the lease is established.
    const { implementationNotesFile } = findPreviousRunNotesFile(packet.taskNumber, packet.worktree, packet.projectRoot, true);
    return {
        ...packet,
        box: "Q_PREVIOUS_RUN_LEFT_NOTES",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        implementationNotesFile: implementationNotesFile ?? "",
        next: "Q_REBASE_RESUMED_WORKTREE_ONTO_STAGING",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
const scriptPath = realpathSync(process.argv[1]!);
const moduleUrl = fileURLToPath(import.meta.url);
const modulePath = realpathSync(moduleUrl);
if (scriptPath === modulePath)
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
