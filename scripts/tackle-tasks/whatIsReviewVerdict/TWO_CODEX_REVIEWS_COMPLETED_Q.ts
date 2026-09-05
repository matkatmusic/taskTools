// TWO_CODEX_REVIEWS_COMPLETED_Q, from pipeline-reviewPlan.mmd. 2 codex reviews done? NO replans; YES scraps the task, or replans once more on the relaunch after a scrap.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readCheckpoint } from "../shared/checkpoint.ts";
import { getAttemptCount, MAX_ATTEMPTS } from "../shared/taskRunState.ts";
import type { WhatIsReviewVerdictPacket } from "./_packet.ts";

type Input = WhatIsReviewVerdictPacket & { verdict: string; notes: string };

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    const reviewsDone = getAttemptCount(packet.taskNumber, "planReview", packet.projectRoot) >= MAX_ATTEMPTS;
    const output = { ...packet, box: "TWO_CODEX_REVIEWS_COMPLETED_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE };

    if (reviewsDone) {
        const checkpoint = readCheckpoint(packet.worktree);
        if (checkpoint === null) throw new Error(`TWO_CODEX_REVIEWS_COMPLETED_Q: no checkpoint in ${packet.worktree}`);
        // The relaunch after a scrap replans once more; reviewQuestion() then approves that plan.
        if (checkpoint.resumedFrom?.exitType === "plan-scrapped") {
            return { ...output, next: "pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q" };
        }
        return {
            ...output, exitType: "plan-scrapped", exitNote: "codex did not accept the plan in two reviews",
            next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
        };
    }
    return { ...output, next: "pipeline-planTheTask.mmd::IS_DIFFICULTY_7_PLUS_Q" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
