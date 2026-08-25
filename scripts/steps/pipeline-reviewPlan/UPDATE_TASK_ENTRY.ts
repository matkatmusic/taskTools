// UPDATE_TASK_ENTRY, from pipeline-reviewPlan.mmd. Mutating: writes codex's notes into tasks.json and raises the review counter.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "../../taskStateLock.ts";

export type UpdateTaskEntryPacket = {
    taskNumber: number;
    taskStateRoot: string;
    repoRoot: string;
    notes: string;
    runId: string;
    sourceBranch: string;
    plan: unknown;
};

function writeCodexReviewNotes(taskStateRoot: string, taskNumber: number, notes: string): number {
    const pair = resolveTaskFiles(taskStateRoot);
    let reviewCount = 0;
    withTaskStateLock(pair.tasksPath, () => {
        const tasks = readTaskFile(pair.tasksPath);
        const entry = tasks.find((task) => task.taskNumber === taskNumber);
        if (!entry) throw new Error(`task ${taskNumber} not found in ${pair.tasksPath}`);
        entry.codexReviewNotes = notes;
        const priorCount = typeof entry.planReviewCount === "number" ? entry.planReviewCount : 0;
        reviewCount = priorCount + 1;
        entry.planReviewCount = reviewCount;
        writeJsonAtomically(pair.tasksPath, tasks);
    });
    return reviewCount;
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as UpdateTaskEntryPacket;
    const reviewCount = writeCodexReviewNotes(packet.taskStateRoot, packet.taskNumber, packet.notes);
    return {
        box: "UPDATE_TASK_ENTRY",
        scriptSignal: SCRIPT_SIGNAL.CONTINUE,
        taskNumber: packet.taskNumber,
        taskStateRoot: packet.taskStateRoot,
        repoRoot: packet.repoRoot,
        reviewCount,
        runId: packet.runId,
        sourceBranch: packet.sourceBranch,
        plan: packet.plan,
    };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
