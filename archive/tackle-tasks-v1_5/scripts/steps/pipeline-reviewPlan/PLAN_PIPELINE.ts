// PLAN_PIPELINE, from pipeline-reviewPlan.mmd. Replan against the amended entry.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type PlanPipelinePacket = {
    taskNumber: number;
    taskStateRoot: string;
    repoRoot: string;
    exitType: string;
    exitNote: string;
    runId: string;
    sourceBranch: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as PlanPipelinePacket;
    return {
        box: "PLAN_PIPELINE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        runId: packet.runId,
        worktree: packet.repoRoot,
        branch: packet.sourceBranch,
        projectRoot: packet.taskStateRoot,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
