// GREEN_IMPLEMENTATION_INPUT, from pipeline-reviewTests.mmd
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { requireAbsolutePath } from "../../tackle-tasks/inputPaths.ts";

// Carried through every box in this pipeline; a box that needs more derives it, never accepts it.
export type ReviewTestsCorePacket = {
    projectRoot: string;
    taskNumber: number;
    worktreePath: string;
    sourceBranch: string;
    runId: string;
};

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as ReviewTestsCorePacket;
    requireAbsolutePath("projectRoot", packet.projectRoot);
    requireAbsolutePath("worktreePath", packet.worktreePath);
    if (!Number.isInteger(packet.taskNumber)) throw new Error("taskNumber is required");
    if (typeof packet.sourceBranch !== "string" || packet.sourceBranch === "") throw new Error("sourceBranch is required");
    if (typeof packet.runId !== "string" || packet.runId === "") throw new Error("runId is required");
    return {
        box: "GREEN_IMPLEMENTATION_INPUT",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        projectRoot: packet.projectRoot,
        taskNumber: packet.taskNumber,
        worktreePath: packet.worktreePath,
        sourceBranch: packet.sourceBranch,
        runId: packet.runId,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
