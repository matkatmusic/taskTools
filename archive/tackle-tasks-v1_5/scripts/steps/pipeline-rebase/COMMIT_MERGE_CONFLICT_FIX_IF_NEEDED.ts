// COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED, from pipeline-rebase.mmd. Mutating: reuses commitTaskWork, which walks occurrences deepest-first and commits whatever the FIX_CONFLICTS agent left dirty.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { commitTaskWork } from "../../tackle-tasks/commitTaskWork.ts";
import { refreshLockHeartbeat, type RebasePacket } from "./packet.ts";

type IncomingPacket = RebasePacket & { next: string; resolved: boolean; unresolvedPaths: string[] };

export function main(input: string): RebasePacket {
    const { next: _next, resolved: _resolved, unresolvedPaths: _unresolvedPaths, ...packet } = JSON.parse(input) as IncomingPacket;
    refreshLockHeartbeat(packet.projectRoot, packet.runId, packet.taskNumber);

    commitTaskWork({
        projectRoot: packet.projectRoot,
        worktreePath: packet.worktreePath,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        stepId: packet.stepId,
        rootSourceBranch: packet.rootSourceBranch,
    });

    return { ...packet, box: "COMMIT_MERGE_CONFLICT_FIX_IF_NEEDED", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
