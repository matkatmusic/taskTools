// EXIT_WORKFLOW_PLAN, from pipeline-plan.mmd: goes to pipeline-failuresExit.mmd::EXIT_TYPE_NOTE_INPUT.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

type Input = {
    taskNumber: number;
    runId: string;
    worktree: string;
    sourceBranch: string;
    projectRoot: string;
    exitType: string;
    exitNote: string;
};

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as Input;
    return {
        box: "EXIT_WORKFLOW_PLAN",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: parsed.taskNumber,
        runId: parsed.runId,
        projectRoot: parsed.projectRoot,
        worktree: parsed.worktree,
        sourceBranch: parsed.sourceBranch,
        exitType: parsed.exitType,
        exitNote: parsed.exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
