// COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED, from pipeline-rebase.mmd. Mutating: commits whatever the FIX_CONFLICTS agent left dirty.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "../shared/sourceRepoLock.ts";
import { commitTaskWork } from "../shared/commitTaskWork.ts";
import type { CommitMergeConflictFixIfNeededPacket } from "./_packet.ts";

function baseBranch(projectRoot: string): string {
    return execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
}

export function main(input: string): CommitMergeConflictFixIfNeededPacket {
    // The prompt block before this one leaves its own next in the packet; one exit path, so drop it.
    const { next: _next, ...packet } = JSON.parse(input) as CommitMergeConflictFixIfNeededPacket & { next?: string };
    refreshOwnedSourceRepoLockOrThrow(packet.projectRoot, buildLockOwner(packet.runId, packet.taskNumber));

    commitTaskWork({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktree,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: "commit-merge-conflict-fix",
        rootSourceBranch: baseBranch(packet.projectRoot),
    });

    return { ...packet, box: "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
