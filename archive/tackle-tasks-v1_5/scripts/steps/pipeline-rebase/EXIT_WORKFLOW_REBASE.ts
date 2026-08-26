// EXIT_WORKFLOW_REBASE, from pipeline-rebase.mmd. Cross-diagram exit box into pipeline-failuresExit.mmd; forwards exitType and exitNote unchanged.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktreePath: string;
    rootSourceBranch: string;
    exitType: string;
    exitNote: string;
};

// Reached from ARE_2_CONFLICT_FIXES_DONE.
export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    return {
        box: "EXIT_WORKFLOW_REBASE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        projectRoot: packet.projectRoot,
        worktree: packet.worktreePath,
        sourceBranch: packet.rootSourceBranch,
        exitType: packet.exitType,
        exitNote: packet.exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
