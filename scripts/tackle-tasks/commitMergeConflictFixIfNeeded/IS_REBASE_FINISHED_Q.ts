// IS_REBASE_FINISHED_Q, from pipeline-rebase.mmd. Decision: read-only, except a resumed-worktree rebase releases the source lock on its way back to the preamble.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { buildLockOwner, releaseSourceRepoLock } from "../shared/sourceRepoLock.ts";
import type { CommitMergeConflictFixIfNeededPacket } from "./_packet.ts";

export function main(input: string): CommitMergeConflictFixIfNeededPacket & { next: string } {
    const packet = JSON.parse(input) as CommitMergeConflictFixIfNeededPacket;
    if (!packet.finished) {
        return { ...packet, box: "IS_REBASE_FINISHED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "ARE_2_CONFLICT_FIXES_DONE_Q" };
    }
    // returnTo is set only by REBASE_RESUMED_WORKTREE_ONTO_STAGING; the merge-time rebase keeps the lock for the merge tail.
    if (packet.returnTo) {
        releaseSourceRepoLock(packet.projectRoot, buildLockOwner(packet.runId, packet.taskNumber));
        return { ...packet, box: "IS_REBASE_FINISHED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: packet.returnTo };
    }
    return { ...packet, box: "IS_REBASE_FINISHED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE, next: "pipeline-runFullSuite.mmd::RUN_FULL_SUITE" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
