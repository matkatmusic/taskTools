// EXIT_WORKFLOW_REVIEW_PLAN, from pipeline-reviewPlan.mmd. Forwards the exit type/note to pipeline-failuresExit.mmd.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type ExitWorkflowReviewPlanPacket = {
    taskNumber: number;
    taskStateRoot: string;
    repoRoot: string;
    exitType: string;
    exitNote: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as ExitWorkflowReviewPlanPacket;
    return {
        box: "EXIT_WORKFLOW_REVIEW_PLAN",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        taskStateRoot: packet.taskStateRoot,
        repoRoot: packet.repoRoot,
        exitType: packet.exitType,
        exitNote: packet.exitNote,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
