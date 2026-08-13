// "move task to completedTasks.json and update tasks blocked by it" — pipeline.mmd.
// Gives closeTasks's positional CLI the stdin/JSON contract every other green box has.
// closeTasks calls unblockDependents internally, which is why the diagram's two boxes are one.
import { readFileSync } from "node:fs";
import { closeTasks } from "../closeTasks.ts";

export type CloseTaskRunInput = {
    taskNumbers: number[];
    closureNote: string | Record<number, string>;
    projectRoot: string;
    commitHashes?: string[] | Record<number, string[]>;
};

export type CloseTaskRunOutput = { closed: number[]; skipped: number[]; unblocked: number[] };

// A retry after the archive-first partial state (task present in both files) is intentional:
// closeTasks's eligibility check is tasks.json presence and its upsert is idempotent, so
// passing the same closureNote/commitHashes back in finishes removal from tasks.json.
export function closeTaskRun(input: CloseTaskRunInput): CloseTaskRunOutput {
    return closeTasks(input.taskNumbers, input.closureNote, input.projectRoot, input.commitHashes ?? []);
}

if (process.argv[1]?.endsWith("closeTaskRun.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CloseTaskRunInput;
    const output = closeTaskRun(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
