// COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED, from pipeline-rebase.mmd. Mutating: commits whatever the FIX_CONFLICTS agent left dirty.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { buildLockOwner, refreshOwnedSourceRepoLockOrThrow } from "../shared/sourceRepoLock.ts";
import { commitTaskWork } from "../shared/commitTaskWork.ts";
import type { CommitMergeConflictFixIfNeededPacket } from "./_packet.ts";

function baseBranch(projectRoot: string): string {
    // return execFileSync("git", ["-C", projectRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    return "staging";
}

const CONFLICT_MARKER_LINE = /^(<{7}|={7}|>{7})/m;

export function main(input: string): CommitMergeConflictFixIfNeededPacket {
    // The prompt block before this one leaves its own next in the packet; one exit path, so drop it.
    const { next: _next, ...packet } = JSON.parse(input) as CommitMergeConflictFixIfNeededPacket & { next?: string };
    if (typeof packet.additionalData.resolved !== "boolean") {
        throw new Error(`COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED: additionalData holds no boolean "resolved"`);
    }
    if (!Array.isArray(packet.additionalData.unresolvedPaths)) {
        throw new Error(`COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED: additionalData holds no array "unresolvedPaths"`);
    }
    refreshOwnedSourceRepoLockOrThrow(packet.projectRoot, buildLockOwner(packet.runId, packet.taskNumber));

    if (packet.additionalData.resolved) {
        const stillMarked = packet.conflictedFilePaths.filter((relativePath) =>
            CONFLICT_MARKER_LINE.test(readFileSync(join(packet.stoppedCheckoutPath, relativePath), "utf8")),
        );
        if (stillMarked.length > 0) {
            throw new Error(`COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED: resolved: true but ${stillMarked.length} file(s) still hold a conflict marker: ${stillMarked.join(", ")}`);
        }
        commitTaskWork({
            projectRoot: packet.projectRoot,
            worktreePath: packet.worktree,
            taskNumber: packet.taskNumber,
            runId: packet.runId,
            stepId: "commit-merge-conflict-fix",
            rootSourceBranch: baseBranch(packet.projectRoot),
        });
    }

    return { ...packet, box: "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
