// WHAT_DID_THE_PLANNER_RETURN, from pipeline-plan.mmd's decision, ported to route only.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";
import type { WhatDidThePlannerReturnPacket } from "./_packet.ts";

type Input = EntryPacket & { message: string; additionalData: { outcome: "PLAN" | "CLARIFY"; planFile: string; clarifyRequest: string } };

export function main(input: string): WhatDidThePlannerReturnPacket & { next: string } {
    const { message: _message, additionalData, ...packet } = JSON.parse(input) as Input;
    const { outcome, planFile, clarifyRequest } = additionalData;
    const output: WhatDidThePlannerReturnPacket = { ...packet, box: "WHAT_DID_THE_PLANNER_RETURN", scriptSignal: SCRIPT_SIGNAL.CONTINUE, planFile, outcome, clarifyRequest };
    if (outcome === "PLAN") {
        const entry = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find((task) => task.taskNumber === packet.taskNumber);
        if (entry === undefined) throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
        if (Number(entry.difficulty) <= 2) {
            return { ...output, next: "pipeline-implementTask.mmd::IMPLEMENT_TASK" };
        }
        return { ...output, next: "pipeline-codexReviewsPlan.mmd::CODEX_REVIEWS_PLAN" };
    }
    if (outcome === "CLARIFY") {
        return { ...output, next: "ARE_2_CLARIFY_ROUNDS_DONE_Q" };
    }
    throw new Error(`unknown planner outcome: ${JSON.stringify(outcome)}`);
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
