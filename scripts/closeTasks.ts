// Moves task numbers from tasks.json to completedTasks.json with a closure note and commit hashes.
import { writeFileSync } from "node:fs";
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { unblockDependents } from "./unblockDependents.ts";

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

export function closeTasks(
  taskNumbers: number[],
  closureNote: string | Record<number, string>,
  projectRoot: string = process.cwd(),
  commitHashes: string[] | Record<number, string[]> = [],
): CloseTasksResult {
  const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
  const tasks = readTaskFile(tasksPath);
  const completedTasks = readTaskFile(completedTasksPath);
  const completedNumbers = new Set(completedTasks.map((task) => task.taskNumber));
  const completionDate = localDate();

  // Duplicates would make the second findIndex return -1 and splice off an unrelated task.
  const uniqueTaskNumbers = [...new Set(taskNumbers)];

  const skipped: number[] = [];
  const willClose = uniqueTaskNumbers.filter((taskNumber) => {
    const eligible =
      tasks.some((task) => task.taskNumber === taskNumber) && !completedNumbers.has(taskNumber);
    if (!eligible) skipped.push(taskNumber);
    return eligible;
  });

  // Resolve every closing task's note/hashes before mutating anything, so a missing Record entry throws before either file is written.
  const resolved = new Map(
    willClose.map((taskNumber) => [
      taskNumber,
      { closureNote: noteFor(closureNote, taskNumber), commitHashes: hashesFor(commitHashes, taskNumber) },
    ]),
  );

  const closed: number[] = [];
  for (const taskNumber of willClose) {
    const index = tasks.findIndex((task) => task.taskNumber === taskNumber);
    const [task] = tasks.splice(index, 1);
    const { closureNote: note, commitHashes: hashes } = resolved.get(taskNumber)!;
    completedTasks.push({ ...task, completionDate, commitHashes: hashes, closureNote: note });
    closed.push(taskNumber);
  }

  let unblocked: number[] = [];
  if (closed.length > 0) {
    unblocked = unblockDependents(tasks, closed);
    writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
    writeFileSync(completedTasksPath, JSON.stringify(completedTasks, null, 2) + "\n");
  }

  return { closed, skipped, unblocked };
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
