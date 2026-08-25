// VERDICT_ERROR, from pipeline-reviewPlan.mmd. The reviewer never read the plan, so this is an operational failure.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

export type VerdictErrorPacket = {
    taskNumber: number;
    taskStateRoot: string;
    repoRoot: string;
    runId: string;
    sourceBranch: string;
    plan: unknown;
    notes: string;
};

// Named explicitly (not omitted) so this box's output shape matches ARE_2_REVIEWS_DONE's, its co-producer into EXIT_WORKFLOW_REVIEW_PLAN.
export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as VerdictErrorPacket;
    return {
        box: "VERDICT_ERROR",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: "EXIT_WORKFLOW_REVIEW_PLAN",
        taskNumber: packet.taskNumber,
        taskStateRoot: packet.taskStateRoot,
        repoRoot: packet.repoRoot,
        exitType: "run-failed",
        exitNote: packet.notes || "the plan review could not run",
        runId: packet.runId,
        sourceBranch: packet.sourceBranch,
        plan: packet.plan,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
