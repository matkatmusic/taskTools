// CLEAN_UP_WORKTREES, from pipeline-mergeSucceededExit.mmd "clean up worktrees, leases, persistence refs and the source lock". Mutating: also releases the source lock.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { cleanupTaskWorktree } from "../shared/cleanupTaskWorktree.ts";

export type CleanUpWorktreesInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
    worktree: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as CleanUpWorktreesInput;
    cleanupTaskWorktree({
        projectRoot: packet.projectRoot, worktreePath: packet.worktree, taskNumber: packet.taskNumber, runId: packet.runId,
    });
    return {
        box: "CLEAN_UP_WORKTREES", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
