// "is the previous run's work resumable?" — plans/tackle-tasks-v1_5-plan.md Phase 3.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { adoptWorktreeLease, readTaskRunState } from "./taskRunState.ts";

export type IsTaskRunResumableOutput = {
    resumable: boolean;
    implementationNotesFile: string | null;
    leaseAdopted: boolean;
};

export function isTaskRunResumable(
    taskNumber: number,
    worktreePath: string,
    runId: string,
    projectRoot: string,
): IsTaskRunResumableOutput {
    const state = readTaskRunState(taskNumber, projectRoot);
    const endedRuns = state.history.filter((run) => run.endedAt !== null);
    const newest = endedRuns[endedRuns.length - 1];
    const notesFile = newest?.implementationNotesFile ?? null;
    if (notesFile === null) return { resumable: false, implementationNotesFile: null, leaseAdopted: false };

    const notesPath = isAbsolute(notesFile) ? notesFile : join(worktreePath, notesFile);
    if (!existsSync(notesPath)) return { resumable: false, implementationNotesFile: null, leaseAdopted: false };

    const { adopted } = adoptWorktreeLease(taskNumber, runId, projectRoot);
    return { resumable: true, implementationNotesFile: notesFile, leaseAdopted: adopted };
}

export type IsTaskRunResumableCliInput = {
    taskNumber: number;
    worktreePath: string;
    runId: string;
    projectRoot: string;
};

if (process.argv[1]?.endsWith("isTaskRunResumable.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as IsTaskRunResumableCliInput;
    const output = isTaskRunResumable(input.taskNumber, input.worktreePath, input.runId, input.projectRoot);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
