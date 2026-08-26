// ACCEPTED_PLAN_INPUT, from pipeline-implement.mmd. Strict entry: the plan and the tasks.json entry, named by task/worktree/root.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../../tackle-tasks/inputPaths.ts";

// Pre-migration default (scripts/tackle-tasks/AgentPromptEmitter.ts:192); no sender carries typecheckCommand.
const DEFAULT_TYPECHECK_COMMAND = "npx tsc --noEmit";

export type AcceptedPlanInput = {
    taskNumber: number;
    projectRoot: string;
    worktreePath: string;
    runId: string;
    sourceBranch: string;
    typecheckCommand: string;
    maxFixRounds: number;
};

export function main(input: string): Record<string, unknown> {
    const { next: _next, ...packet } = JSON.parse(input) as AcceptedPlanInput & { next?: string };
    if (!Number.isInteger(packet.taskNumber)) throw new Error("taskNumber is required");
    requireAbsolutePath("projectRoot", packet.projectRoot);
    requireAbsolutePath("worktreePath", packet.worktreePath);
    if (typeof packet.runId !== "string" || packet.runId === "") throw new Error("runId is required");
    if (typeof packet.sourceBranch !== "string" || packet.sourceBranch === "") throw new Error("sourceBranch is required");
    if (!Number.isInteger(packet.maxFixRounds)) throw new Error("maxFixRounds is required");
    const typecheckCommand = packet.typecheckCommand || DEFAULT_TYPECHECK_COMMAND;
    return { ...packet, box: "ACCEPTED_PLAN_INPUT", scriptSignal: SCRIPT_SIGNAL.CONTINUE, typecheckCommand };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
