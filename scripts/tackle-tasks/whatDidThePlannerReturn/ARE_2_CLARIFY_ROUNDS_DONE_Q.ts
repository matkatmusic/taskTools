// ARE_2_CLARIFY_ROUNDS_DONE_Q, from pipeline-plan.mmd's ARE_2_CLARIFY_ROUNDS_DONE decision.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { getAttemptCount, MAX_ATTEMPTS } from "../shared/taskRunState.ts";
import type { WhatDidThePlannerReturnPacket } from "./_packet.ts";

export function main(input: string): WhatDidThePlannerReturnPacket & { next: string } {
    const packet = JSON.parse(input) as WhatDidThePlannerReturnPacket;
    const output = { ...packet, box: "ARE_2_CLARIFY_ROUNDS_DONE_Q", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
    const roundsDone = getAttemptCount(packet.taskNumber, "clarify", packet.projectRoot) >= MAX_ATTEMPTS;
    if (roundsDone) {
        return {
            ...output,
            exitType: "clarify-stuck",
            exitNote: "the planner asked twice for something the docs cannot supply. worktree preserved.",
            next: "pipeline-failuresExit.mmd::FAILURES_EXIT",
        };
    }
    return { ...output, next: "WRITE_CLARIFY_REQUEST" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
