// UPDATE_TASKS_JSON, from pipeline-reviewPlan.mmd. Mutating: writes codex's notes into tasks.json and raises the planReview counter.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../contracts.ts";
import { readTaskFile, resolveTaskFiles } from "../../taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "../../taskStateLock.ts";
import { raiseAttemptCount } from "../shared/taskRunState.ts";
import type { WhatIsReviewVerdictPacket } from "./_packet.ts";

type Input = WhatIsReviewVerdictPacket & { verdict: string; notes: string };

function writeCodexReviewNotes(projectRoot: string, taskNumber: number, notes: string): void {
    const pair = resolveTaskFiles(projectRoot);
    withTaskStateLock(pair.tasksPath, () => {
        const tasks = readTaskFile(pair.tasksPath);
        const entry = tasks.find((task) => task.taskNumber === taskNumber);
        if (!entry) throw new Error(`task ${taskNumber} not found in ${pair.tasksPath}`);
        entry.codexReviewNotes = notes;
        writeJsonAtomically(pair.tasksPath, tasks);
    });
}

export function main(input: string): Record<string, unknown> {
    const packet = JSON.parse(input) as Input;
    writeCodexReviewNotes(packet.projectRoot, packet.taskNumber, packet.notes);
    raiseAttemptCount(packet.taskNumber, packet.runId, "planReview", packet.projectRoot);
    return { ...packet, box: "UPDATE_TASKS_JSON", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
if (realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)))
    console.log(JSON.stringify(main(process.argv[2] ?? "")));
