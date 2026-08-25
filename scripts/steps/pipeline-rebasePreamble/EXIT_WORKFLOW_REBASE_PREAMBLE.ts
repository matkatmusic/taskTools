// EXIT_WORKFLOW_REBASE_PREAMBLE, from pipeline-rebasePreamble.mmd Cross-diagram exit box into pipeline-failuresExit.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type ExitWorkflowRebasePreambleInput = {
    runId: string;
    taskNumber: number;
    projectRoot: string;
    exitType: string;
    exitNote: string;
};

export function main(input: string): Record<string, unknown> {
    const parsed = JSON.parse(input) as ExitWorkflowRebasePreambleInput;
    return {
        box: "EXIT_WORKFLOW_REBASE_PREAMBLE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        exitType: parsed.exitType,
        exitNote: parsed.exitNote,
        runId: parsed.runId,
        taskNumber: parsed.taskNumber,
        projectRoot: parsed.projectRoot,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
