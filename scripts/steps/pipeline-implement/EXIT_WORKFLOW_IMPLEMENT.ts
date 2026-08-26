// EXIT_WORKFLOW_IMPLEMENT, from pipeline-implement.mmd. Forwards the exit type and note to pipeline-failuresExit.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type Input = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    worktreePath: string;
    sourceBranch: string;
    exitType: string;
    exitNote: string;
};

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as Input;
    return {
        box: "EXIT_WORKFLOW_IMPLEMENT",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        projectRoot: parsed.projectRoot,
        worktree: parsed.worktreePath,
        sourceBranch: parsed.sourceBranch,
        exitType: parsed.exitType,
        exitNote: parsed.exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
