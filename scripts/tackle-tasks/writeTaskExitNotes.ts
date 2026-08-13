// "write exit type and exit notes to tasks.json" / "write exit type completed to tasks.json" — pipeline.mmd.
import { readFileSync } from "node:fs";
import { replaceEndedRunOutcome, updateCurrentTaskRun, type TaskExitType } from "./taskRunState.ts";

const EXIT_TYPES: readonly TaskExitType[] = [
    "completed", "invalid-number", "not-open", "already-active", "blocked",
    "plan-scrapped", "tests-red", "tests-flagged", "suite-red",
    "rebase-stuck", "merge-failed", "fence-violation", "run-failed",
];

export type WriteTaskExitNotesInput = {
    taskNumber: number;
    projectRoot: string;
    exitType: string;
    exitNote: string;
    reopen?: boolean;
};

export type WriteTaskExitNotesOutput = { exitType: TaskExitType; exitNote: string };

// rule 10: reopening overwrites exit type completed with run-failed on the already-ended
// success tail, via replaceEndedRunOutcome, which owns that whole transition under one lock.
export function writeTaskExitNotes(input: WriteTaskExitNotesInput): WriteTaskExitNotesOutput {
    if (!EXIT_TYPES.includes(input.exitType as TaskExitType)) {
        throw new Error(`writeTaskExitNotes: unknown exit type "${input.exitType}"`);
    }
    const exitType = input.exitType as TaskExitType;
    if (input.reopen) {
        replaceEndedRunOutcome(input.taskNumber, exitType, input.exitNote, input.projectRoot);
    } else {
        updateCurrentTaskRun(input.taskNumber, { exitType, exitNote: input.exitNote }, input.projectRoot);
    }
    return { exitType, exitNote: input.exitNote };
}

if (process.argv[1]?.endsWith("writeTaskExitNotes.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as WriteTaskExitNotesInput;
    const output = writeTaskExitNotes(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
