// "move task to completedTasks.json and update tasks blocked by it" — pipeline.mmd.
// F12: closeTaskRunReconciled is the only writer here — it runs all four presence cases
// inside one withTaskStateLock transaction that reads both task files once. This wrapper
// only validates input; commit hashes are always derived from the recorded run, never
// caller-supplied, and an already-archived record is never rewritten.
import { readFileSync } from "node:fs";
import { closeTaskRunReconciled, type CloseTaskRunOutput } from "../../close-tasks/closeTasks.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type CloseTaskRunInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    closureNote: string;
    stepId: string;
};

export type { CloseTaskRunOutput };

// F12: closeTaskRun's four-case behaviour —
//   1. only in tasks.json: the newest run must be inactive, ended, completed; hashes are
//      derived from that run's own chronological commits before the first archive write.
//      Writes both tasks.json and completedTasks.json.
//   2. in both files, same run: the archived record is immutable durable evidence — only
//      the open record's removal/unblocking is completed. Writes only tasks.json.
//   3. only in completedTasks.json: reconciled success only on an exact run/note/hash
//      match; any mismatch is reported as `ambiguous`, distinct from `skipped`. Writes nothing.
//   4. in neither file: reported via `skipped`. Writes nothing.
export function closeTaskRun(input: CloseTaskRunInput): CloseTaskRunOutput {
    requireAbsolutePath("projectRoot", input.projectRoot);
    if (Object.prototype.hasOwnProperty.call(input, "commitHashes")) {
        throw new Error("closeTaskRun: commitHashes must not be supplied; hashes are derived from the recorded run");
    }

    return closeTaskRunReconciled(input.taskNumber, input.runId, input.closureNote, input.projectRoot, input.stepId);
}

if (process.argv[1]?.endsWith("closeTaskRun.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CloseTaskRunInput;
    const output = closeTaskRun(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
