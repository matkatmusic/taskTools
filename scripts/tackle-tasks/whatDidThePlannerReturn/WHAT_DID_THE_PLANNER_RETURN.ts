// WHAT_DID_THE_PLANNER_RETURN, from pipeline-plan.mmd's decision, ported to route only.
import { readFileSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { readTaskFile, resolveTaskFiles, taskHasTests } from "../../shared/taskFiles.ts";
import { modifiableFiles } from "../../shared/prepareTasks.ts";
import { TASK_HAS_TESTS } from "../../shared/resultCodes.ts";
import { pairedTestPath } from "../shared/preparedTask.ts";
import type { EntryPacket } from "../preambleStatusCheck/_packet.ts";
import type { WhatDidThePlannerReturnPacket } from "./_packet.ts";

type Input = EntryPacket & { message: string; additionalData: { outcome: "PLAN" | "CLARIFY"; planFile: string; clarifyRequest: string } };

export function main(input: string): Record<string, unknown> {
    const { message: _message, additionalData, ...packet } = JSON.parse(input) as Input;
    const { outcome, planFile, clarifyRequest } = additionalData;
    const output: WhatDidThePlannerReturnPacket & { reviewOutputFile: string; verdict: string; notes: string } = {
        ...packet, box: "WHAT_DID_THE_PLANNER_RETURN", scriptSignal: SCRIPT_SIGNAL.CONTINUE, planFile, outcome, clarifyRequest,
        reviewOutputFile: "", verdict: "", notes: "",
    };
    if (outcome === "PLAN") {
        const entry = readTaskFile(resolveTaskFiles(packet.projectRoot).tasksPath).find((task) => task.taskNumber === packet.taskNumber);
        if (entry === undefined) throw new Error(`task ${packet.taskNumber} not found in tasks.json`);
        if (taskHasTests(entry) === TASK_HAS_TESTS) {
            const declaredTestBasenames = modifiableFiles(entry).map((file) => basename(pairedTestPath(packet.worktree, file)));
            const planText = readFileSync(planFile, "utf8");
            const unnamedTestBasenames = declaredTestBasenames.filter((name) => !planText.includes(name));
            if (unnamedTestBasenames.length > 0) {
                return {
                    ...output,
                    verdict: "AMEND",
                    notes: `the task declares tests but the plan does not name: ${unnamedTestBasenames.map((name) => `tests/${name}`).join(", ")}`,
                    next: "pipeline-whatIsReviewVerdict.mmd::UPDATE_TASKS_JSON",
                };
            }
        }
        if (Number(entry.difficulty) <= 3) {
            return { ...output, next: "pipeline-implementTask.mmd::IMPLEMENT_TASK" };
        }
        return { ...output, next: "pipeline-codexReviewsPlan.mmd::IS_PLAN_APPROVED_BY_DEFAULT_Q" };
    }
    if (outcome === "CLARIFY") {
        return { ...output, next: "ARE_2_CLARIFY_ROUNDS_DONE_Q" };
    }
    throw new Error(`unknown planner outcome: ${JSON.stringify(outcome)}`);
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
