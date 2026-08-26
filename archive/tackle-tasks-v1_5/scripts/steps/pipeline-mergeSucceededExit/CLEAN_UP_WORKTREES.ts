// CLEAN_UP_WORKTREES, from pipeline-mergeSucceededExit.mmd. The only box here that releases the source lock and worktree lease.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { cleanupTaskWorktree } from "../../tackle-tasks/cleanupTaskWorktree.ts";

export type CleanUpWorktreesInput = {
    box: string;
    scriptSignal: string;
    projectRoot: string;
    taskNumber: number;
    runId: string;
    worktreePath: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as CleanUpWorktreesInput;
    cleanupTaskWorktree({
        projectRoot: packet.projectRoot, worktreePath: packet.worktreePath, taskNumber: packet.taskNumber, runId: packet.runId,
    });
    return {
        box: "CLEAN_UP_WORKTREES", scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot, taskNumber: packet.taskNumber, runId: packet.runId,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
