// DRAFT_PLAN_INPUT, from pipeline-reviewPlan.mmd. Strict entry: the real output of pipeline-plan.mmd::REVIEW_PLAN_PIPELINE.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../../tackle-tasks/inputPaths.ts";
import { loadPreparedTask } from "../../tackle-tasks/preparedTask.ts";

export type DraftPlanInputPacket = {
    taskNumber: number;
    runId: string;
    worktree: string;
    sourceBranch: string;
    projectRoot: string;
    plan: unknown;
    clarifyRequest: string | null;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as DraftPlanInputPacket;
    if (!Number.isInteger(packet.taskNumber)) throw new Error("taskNumber is required");
    if (typeof packet.runId !== "string" || packet.runId === "") throw new Error("runId is required");
    requireAbsolutePath("worktree", packet.worktree);
    if (typeof packet.sourceBranch !== "string" || packet.sourceBranch === "") throw new Error("sourceBranch is required");
    requireAbsolutePath("projectRoot", packet.projectRoot);
    const prepared = loadPreparedTask(packet.taskNumber, packet.worktree, packet.projectRoot);
    return {
        box: "DRAFT_PLAN_INPUT",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        taskStateRoot: packet.projectRoot,
        repoRoot: packet.worktree,
        briefFile: prepared.briefFile,
        planFile: prepared.planFile,
        reviewOutputFile: prepared.reviewOutputFile,
        ownedFilePaths: prepared.ownedFilePaths,
        runId: packet.runId,
        sourceBranch: packet.sourceBranch,
        plan: packet.plan,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
