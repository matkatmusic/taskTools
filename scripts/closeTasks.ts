// Moves task numbers from tasks.json to completedTasks.json with a closure note and commit hashes.
import { readFileSync } from "node:fs";
import { leadingTaskNumbers, resolveTaskFiles } from "./taskFiles.ts";
import type { TaskRecord } from "./taskFiles.ts";
import { unblockDependents } from "./unblockDependents.ts";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";

export interface CloseTasksResult {
  closed: number[];
  skipped: number[];
  unblocked: number[];
}

// Local calendar date, not UTC — toISOString() rolls to tomorrow during US evening hours.
function localDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function noteFor(closureNote: string | Record<number, string>, taskNumber: number): string {
  if (typeof closureNote === "string") return closureNote;
  if (!(taskNumber in closureNote)) {
    throw new Error(`closeTasks: no closureNote given for task ${taskNumber}`);
  }
  return closureNote[taskNumber];
}

function hashesFor(
  commitHashes: string[] | Record<number, string[]>,
  taskNumber: number,
): string[] {
  if (Array.isArray(commitHashes)) return commitHashes;
  if (!(taskNumber in commitHashes)) {
    throw new Error(`closeTasks: no commitHashes given for task ${taskNumber}`);
  }
  return commitHashes[taskNumber];
}

function upsertInto(base: TaskRecord[], records: Map<number, TaskRecord>): TaskRecord[] {
  const appended = [...base];
  for (const [taskNumber, record] of records) {
    const existingIndex = appended.findIndex((t) => t.taskNumber === taskNumber);
    if (existingIndex === -1) {
      appended.push(record);
    } else {
      appended[existingIndex] = record;
    }
  }
  return appended;
}

export function closeTasks(
  taskNumbers: number[],
  closureNote: string | Record<number, string>,
  projectRoot: string = process.cwd(),
  commitHashes: string[] | Record<number, string[]> = [],
): CloseTasksResult {
  return withTaskStateLock(projectRoot, () =>
    closeTasksLocked(taskNumbers, closureNote, projectRoot, commitHashes));
}

function closeTasksLocked(
  taskNumbers: number[],
  closureNote: string | Record<number, string>,
  projectRoot: string,
  commitHashes: string[] | Record<number, string[]>,
): CloseTasksResult {
  const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
  const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as TaskRecord[];
  const completed = JSON.parse(readFileSync(completedTasksPath, "utf8")) as TaskRecord[];
  const completionDate = localDate();

  // Duplicates would make the second findIndex return -1 and splice off an unrelated task.
  const uniqueTaskNumbers = [...new Set(taskNumbers)];

  // Eligibility is tasks.json presence only, so a retry after a partial prior write still closes it.
  const skipped: number[] = [];
  const willClose = uniqueTaskNumbers.filter((taskNumber) => {
    const eligible = tasks.some((task) => task.taskNumber === taskNumber);
    if (!eligible) skipped.push(taskNumber);
    return eligible;
  });

  if (willClose.length === 0) {
    return { closed: [], skipped, unblocked: [] };
  }

  // Resolve every note/hashes first, so a missing Record entry throws before any write.
  const resolved = new Map(
    willClose.map((taskNumber) => [
      taskNumber,
      {
        closureNote: noteFor(closureNote, taskNumber),
        commitHashes: hashesFor(commitHashes, taskNumber),
      },
    ]),
  );

  // The archived records and the removal both come from this one locked snapshot.
  const records = new Map(willClose.map((taskNumber) => {
    const task = tasks.find((t) => t.taskNumber === taskNumber)!;
    const { closureNote: note, commitHashes: hashes } = resolved.get(taskNumber)!;
    return [taskNumber, { ...task, completionDate, commitHashes: hashes, closureNote: note }];
  }));

  const nextCompleted = upsertInto(completed, records);
  const remaining = tasks.filter((task) => !willClose.includes(task.taskNumber));
  const unblocked = unblockDependents(remaining, willClose);

  // Archive first: a removal failure leaves the task in both files, safely retryable.
  writeJsonAtomically(completedTasksPath, nextCompleted);
  writeJsonAtomically(tasksPath, remaining);

  return { closed: willClose, skipped, unblocked };
}

function parseCloseNoteArg(raw: string): string | Record<number, string> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<number, string>;
    }
  } catch {
    // not JSON — treat as a plain free-text closure note
  }
  return raw;
}

function parseCommitHashesArg(raw: string | undefined): string[] | Record<number, string[]> | undefined {
  if (raw === undefined) return undefined;
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? (parsed as string[]) : (parsed as Record<number, string[]>);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const taskNumbers = leadingTaskNumbers([process.argv[2] ?? ""]);
  const closureNote = parseCloseNoteArg(process.argv[3] ?? "");
  const commitHashes = parseCommitHashesArg(process.argv[4]);
  const { closed, skipped, unblocked } =
    commitHashes === undefined
      ? closeTasks(taskNumbers, closureNote)
      : closeTasks(taskNumbers, closureNote, undefined, commitHashes);
  process.stdout.write(
    `closed: ${closed.length > 0 ? closed.join(", ") : "none"}\n` +
      `skipped (already completed or not found): ${skipped.length > 0 ? skipped.join(", ") : "none"}\n` +
      (unblocked.length > 0
        ? `removed closed task(s) from blockedBy of task(s): ${unblocked.join(", ")}\n`
        : "no blockedBy references to the closed task(s)\n"),
  );
}
