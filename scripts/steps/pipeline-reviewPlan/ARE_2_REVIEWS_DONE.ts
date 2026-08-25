// ARE_2_REVIEWS_DONE, from pipeline-reviewPlan.mmd. 2 codex reviews done? NO replans; YES scraps the task.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";

const REVIEWS_LIMIT = 2;

export type Are2ReviewsDonePacket = {
    taskNumber: number;
    taskStateRoot: string;
    repoRoot: string;
    reviewCount: number;
    runId: string;
    sourceBranch: string;
    plan: unknown;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Are2ReviewsDonePacket;
    const reviewsDone = packet.reviewCount >= REVIEWS_LIMIT;
    return {
        box: "ARE_2_REVIEWS_DONE",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        next: reviewsDone ? "EXIT_WORKFLOW_REVIEW_PLAN" : "PLAN_PIPELINE",
        taskNumber: packet.taskNumber,
        taskStateRoot: packet.taskStateRoot,
        repoRoot: packet.repoRoot,
        exitType: reviewsDone ? "plan-scrapped" : "",
        exitNote: reviewsDone ? "codex did not accept the plan in two reviews" : "",
        runId: packet.runId,
        sourceBranch: packet.sourceBranch,
        plan: packet.plan,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
