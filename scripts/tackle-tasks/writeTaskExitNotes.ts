// "write exit type and exit notes to tasks.json" / "write exit type completed to tasks.json" — pipeline.mmd.
import { readFileSync } from "node:fs";
import { replaceEndedRunOutcome, updateCurrentTaskRun, type TaskExitType } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

const EXIT_TYPES: readonly TaskExitType[] = [
    "completed", "invalid-number", "already-active", "blocked",
    "plan-scrapped", "tests-red", "tests-flagged", "suite-red",
    "rebase-stuck", "merge-failed", "fence-violation", "run-failed",
];

export type WriteTaskExitNotesInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    exitType: string;
    exitNote: string;
    reopen?: boolean;
};

export type WriteTaskExitNotesOutput = { exitType: TaskExitType; exitNote: string };

// rule 10: reopening overwrites exit type completed with run-failed on the already-ended
// success tail, via replaceEndedRunOutcome, which owns that whole transition under one lock.
// F6: runId fences the write to the run that requested it, never "whichever run is newest".
export function writeTaskExitNotes(input: WriteTaskExitNotesInput): WriteTaskExitNotesOutput {
    requireAbsolutePath("projectRoot", input.projectRoot);
    if (!EXIT_TYPES.includes(input.exitType as TaskExitType)) {
        throw new Error(`writeTaskExitNotes: unknown exit type "${input.exitType}"`);
    }
    const exitType = input.exitType as TaskExitType;
    if (input.reopen) {
        replaceEndedRunOutcome(input.taskNumber, input.runId, exitType, input.exitNote, input.projectRoot);
    } else {
        updateCurrentTaskRun(input.taskNumber, input.runId, { exitType, exitNote: input.exitNote }, input.projectRoot);
    }
    return { exitType, exitNote: input.exitNote };
}

if (process.argv[1]?.endsWith("writeTaskExitNotes.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as WriteTaskExitNotesInput;
    const output = writeTaskExitNotes(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
