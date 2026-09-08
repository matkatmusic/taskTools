// DOES_FENCE_COVER_WORKTREE_Q, from pipeline-preambleStatusCheck.mmd. "does the task's file list cover what the worktree touched?"
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { checkResumedWorktreeFence } from "../shared/checkResumedWorktreeFence.ts";
import type { EntryPacket } from "./_packet.ts";

export function main(input: string): EntryPacket & { next: string } {
    const { next: _next, ...packet } = JSON.parse(input) as EntryPacket & { next?: string };
    const { inside, violations } = checkResumedWorktreeFence({
        projectRoot: packet.projectRoot, worktreePath: packet.worktree, taskNumber: packet.taskNumber,
    });
    if (inside) {
        return {
            ...packet, box: "DOES_FENCE_COVER_WORKTREE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
            docsMode: "UPDATE", next: "INIT_SUBMODULES_RECURSIVELY",
        };
    }
    return {
        ...packet,
        box: "DOES_FENCE_COVER_WORKTREE_Q",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        exitType: "fence-violation",
        exitNote: `paused, fence-violation: the resumed worktree touched files the task does not own: ${violations.join(", ")}. nothing merged. worktree preserved. Review those files. Small and part of the task: add them to the task's modifiableFiles or files in tasks.json, then run /tackle-tasks [${packet.taskNumber}] to resume at this check. Large or not part of the task: ask the user what to do.`,
        next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
