// WRITE_CLARIFY_REQUEST, from pipeline-plan.mmd. mutating: writes tasks.json's clarifyRequest and raises the clarify counter.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../shared/inputPaths.ts";
import { raiseAttemptCount } from "../shared/taskRunState.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "../../taskStateLock.ts";
import type { WhatDidThePlannerReturnPacket } from "./_packet.ts";

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

export function main(input: string): WhatDidThePlannerReturnPacket {
    const packet = JSON.parse(input) as WhatDidThePlannerReturnPacket;
    writeClarifyRequest(packet.projectRoot, packet.taskNumber, packet.clarifyRequest);
    raiseAttemptCount(packet.taskNumber, packet.runId, "clarify", packet.projectRoot);
    return { ...packet, box: "WRITE_CLARIFY_REQUEST", scriptSignal: SCRIPT_SIGNAL.CONTINUE, docsMode: "UPDATE", planFile: "" };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
