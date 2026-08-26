// WHAT_DID_THE_PLANNER_RETURN, from _pipeline-monolith.mmd. Absorbs pipeline-plan.mmd's routing, clarify cap, and WRITE_CLARIFY_REQUEST.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../../tackle-tasks/inputPaths.ts";
import { getAttemptCount, MAX_ATTEMPTS, raiseAttemptCount } from "../../tackle-tasks/taskRunState.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "../../taskStateLock.ts";
import type { EntryPacket } from "./_packet.ts";

// The hook merges PLAN_THE_TASK's input packet with the planner agent's answer; this is that merge.
type Input = EntryPacket & { outcome: "PLAN" | "CLARIFY"; planFile: string; clarifyRequest: string };

// Ported from scripts/tackle-tasks/writeClarifyRequest.ts, the box's old home.
function writeClarifyRequest(projectRoot: string, taskNumber: number, clarifyRequest: string): void {
    const root = requireAbsolutePath("projectRoot", projectRoot);
    const trimmed = clarifyRequest.trim();
    if (trimmed === "") throw new Error(`write-clarify-request: task ${taskNumber} sent an empty request`);

    const pair = resolveTaskFiles(root);
    withTaskStateLock(pair.tasksPath, () => {
        const tasks = readTaskFile(pair.tasksPath);
        const entry = tasks.find((task: any) => task.taskNumber === taskNumber);
        if (!entry) throw new Error(`task ${taskNumber} not found in ${pair.tasksPath}`);
        (entry as any).clarifyRequest = trimmed;
        writeJsonAtomically(pair.tasksPath, tasks);
    });
}

export function main(input: string): EntryPacket & { next: string } {
    const { outcome, clarifyRequest, ...packet } = JSON.parse(input) as Input;
    const output: EntryPacket = { ...packet, box: "WHAT_DID_THE_PLANNER_RETURN", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
    if (outcome === "PLAN") {
        return { ...output, next: "CODEX_REVIEWS_PLAN" };
    }
    if (outcome === "CLARIFY") {
        // The counter lives in tasks.json's run record, so it survives the agent() boundary.
        if (getAttemptCount(packet.taskNumber, "clarify", packet.projectRoot) >= MAX_ATTEMPTS) {
            return {
                ...output, exitType: "clarify-stuck",
                exitNote: "the planner asked twice for something the docs cannot supply. worktree preserved.", next: "FAILURES_EXIT",
            };
        }
        writeClarifyRequest(packet.projectRoot, packet.taskNumber, clarifyRequest);
        raiseAttemptCount(packet.taskNumber, packet.runId, "clarify", packet.projectRoot);
        // Back to DOCUMENT_GENERATION mid-subgraph; the hook then walks into PLAN_THE_TASK and hands this agent its prompt.
        return { ...output, docsMode: "UPDATE", planFile: "", next: "DOCUMENT_GENERATION" };
    }
    throw new Error(`unknown planner outcome: ${JSON.stringify(outcome)}`);
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
