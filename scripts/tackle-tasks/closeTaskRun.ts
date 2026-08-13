// "move task to completedTasks.json and update tasks blocked by it" — pipeline.mmd.
// F12: closeTaskRunChecked is the only writer here — it runs the whole eligibility check and
// the write inside one withTaskStateLock window. This wrapper only ever supplies it a
// closureNote; commit hashes are always derived from the recorded run, never caller-supplied.
import { readFileSync } from "node:fs";
import { closeTaskRunChecked, type CloseTasksResult } from "../closeTasks.ts";
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "../taskFiles.ts";
import type { TaskRunRecord, TaskRunState } from "./taskRunState.ts";
import { requireAbsolutePath } from "./inputPaths.ts";

export type CloseTaskRunInput = {
    taskNumber: number;
    runId: string;
    projectRoot: string;
    closureNote: string;
};

export type CloseTaskRunOutput = CloseTasksResult;

type ArchivedTaskRecord = TaskRecord & { run?: TaskRunState; closureNote?: unknown; commitHashes?: unknown };

// The ended, completed history entry for runId, if the record has one at all.
function findEndedRunEntry(record: ArchivedTaskRecord | undefined, runId: string): TaskRunRecord | undefined {
    return record?.run?.history.find(
        (candidate) => candidate.runId === runId && candidate.endedAt !== null && candidate.exitType === "completed",
    );
}

function chronologicalHashes(record: TaskRunRecord): string[] {
    return record.commits.map((commit) => commit.hash);
}

const notFound = (taskNumber: number): CloseTaskRunOutput => ({ closed: [], skipped: [taskNumber], unblocked: [] });
const alreadyClosed = (taskNumber: number): CloseTaskRunOutput => ({ closed: [taskNumber], skipped: [], unblocked: [] });

// The task is closed already (absent from tasks.json). A retry here never writes — it only
// reconciles: success is reported only when the archived record actually matches this call.
function reconcileAlreadyClosed(input: CloseTaskRunInput, archived: ArchivedTaskRecord | undefined): CloseTaskRunOutput {
    if (archived === undefined) return notFound(input.taskNumber);
    const ended = findEndedRunEntry(archived, input.runId);
    if (ended === undefined) return notFound(input.taskNumber);
    const noteMatches = archived.closureNote === input.closureNote;
    const hashesMatch = JSON.stringify(archived.commitHashes) === JSON.stringify(chronologicalHashes(ended));
    return noteMatches && hashesMatch ? alreadyClosed(input.taskNumber) : notFound(input.taskNumber);
}

// F12: closeTaskRun's four-case behaviour —
//   1. only in tasks.json: closeTaskRunChecked verifies runId is the newest, inactive,
//      completed run, then archives the caller's note and the run's own commit hashes.
//   2. in both files, same run: the caller's note/hashes are ignored; the already-archived
//      note is reused verbatim so a differing retry can never overwrite durable evidence.
//   3. only in completedTasks.json: reconciled success only when the archived record's run,
//      note, and derived hashes all match this call; otherwise reported as not closed.
//   4. in neither file: reported as not closed.
export function closeTaskRun(input: CloseTaskRunInput): CloseTaskRunOutput {
    requireAbsolutePath("projectRoot", input.projectRoot);
    if (Object.prototype.hasOwnProperty.call(input, "commitHashes")) {
        throw new Error("closeTaskRun: commitHashes must not be supplied; hashes are derived from the recorded run");
    }

    const { tasksPath, completedTasksPath } = resolveTaskFiles(input.projectRoot);
    const openTasks = readTaskFile(tasksPath) as ArchivedTaskRecord[];
    const openTask = openTasks.find((task) => task.taskNumber === input.taskNumber);
    const completedTasks = readTaskFile(completedTasksPath) as ArchivedTaskRecord[];
    const archived = completedTasks.find((task) => task.taskNumber === input.taskNumber);

    if (openTask === undefined) {
        return reconcileAlreadyClosed(input, archived);
    }

    let closureNote = input.closureNote;
    if (archived !== undefined) {
        const ended = findEndedRunEntry(archived, input.runId);
        if (ended === undefined) {
            throw new Error(
                `closeTaskRun: task ${input.taskNumber} is archived under a different run than "${input.runId}"`,
            );
        }
        // Reuse the already-archived note exactly, never the caller's (possibly recomputed) one.
        closureNote = archived.closureNote as string;
    }

    return closeTaskRunChecked(input.taskNumber, input.runId, closureNote, input.projectRoot);
}

if (process.argv[1]?.endsWith("closeTaskRun.ts")) {
    const input = JSON.parse(readFileSync(0, "utf8")) as CloseTaskRunInput;
    const output = closeTaskRun(input);
    process.stdout.write(`${JSON.stringify(output)}\n`);
}
