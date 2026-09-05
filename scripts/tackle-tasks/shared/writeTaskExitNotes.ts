// "write exit type and exit notes to tasks.json" / "write exit type completed to tasks.json" — pipeline.mmd.
import { readFileSync } from "node:fs";
import { replaceEndedRunOutcome, updateCurrentTaskRun, type TaskExitType } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

const EXIT_TYPES: readonly TaskExitType[] = [
    "completed", "invalid-number", "already-active", "blocked",
    "plan-scrapped", "tests-red", "tests-flagged", "suite-red",
    "rebase-stuck", "merge-failed", "fence-violation", "run-failed",
    "clarify-stuck", "agent-failed", "partially-published", "not-resumable", "implementation-incomplete",
    "block-failed",
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

// Rule 10: reopening replaces completed with run-failed via replaceEndedRunOutcome. F6: runId fences writes to the requesting run.
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
