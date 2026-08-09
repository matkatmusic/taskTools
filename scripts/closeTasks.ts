// Moves task numbers from tasks.json to completedTasks.json with a closure note and commit hashes.
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { leadingTaskNumbers, resolveTaskFiles } from "./taskFiles.ts";
import type { TaskRecord } from "./taskFiles.ts";
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

const MAX_WRITE_RETRIES = 5;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tmpPathFor(targetPath: string): string {
  return join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.tmp`);
}

// Re-hashes before rename; a mismatch means another writer landed, so this retries onto the new bytes.
// ponytail: detect-and-retry only, the re-hash-to-rename gap is still unsafe; upgrade path is a stale-timeout lockfile.
export function hashGuardedRewrite<T>(
  targetPath: string,
  mutate: (parsed: T) => T,
  afterWriteTmp?: () => void,
): T {
  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
    const before = readFileSync(targetPath);
    const hashBefore = sha256Hex(before);
    const next = mutate(JSON.parse(before.toString("utf8")) as T);
    const tmpPath = tmpPathFor(targetPath);
    writeFileSync(tmpPath, JSON.stringify(next, null, 2) + "\n");
    afterWriteTmp?.();
    const after = readFileSync(targetPath);
    if (sha256Hex(after) !== hashBefore) {
      unlinkSync(tmpPath);
      continue;
    }
    renameSync(tmpPath, targetPath);
    return next;
  }
  throw new Error(
    `closeTasks: concurrent writes to ${targetPath} prevented an atomic update after ${MAX_WRITE_RETRIES} attempts`,
  );
}

export function closeTasks(
  taskNumbers: number[],
  closureNote: string | Record<number, string>,
  projectRoot: string = process.cwd(),
  commitHashes: string[] | Record<number, string[]> = [],
): CloseTasksResult {
  const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
  const tasks = JSON.parse(readFileSync(tasksPath, "utf8")) as TaskRecord[];
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

  // Resolve every note/hashes/record first, so a missing Record entry throws before any write.
  const resolved = new Map(
    willClose.map((taskNumber) => [
      taskNumber,
      {
        task: tasks.find((task) => task.taskNumber === taskNumber)!,
        closureNote: noteFor(closureNote, taskNumber),
        commitHashes: hashesFor(commitHashes, taskNumber),
      },
    ]),
  );

  // Written first; upserts, not skips, so a retry overwrites a stale prior-run record.
  hashGuardedRewrite<TaskRecord[]>(completedTasksPath, (parsedCompleted) => {
    const appended = [...parsedCompleted];
    for (const taskNumber of willClose) {
      const { task, closureNote: note, commitHashes: hashes } = resolved.get(taskNumber)!;
      const record = { ...task, completionDate, commitHashes: hashes, closureNote: note };
      const existingIndex = appended.findIndex((t) => t.taskNumber === taskNumber);
      if (existingIndex === -1) {
        appended.push(record);
      } else {
        appended[existingIndex] = record;
      }
    }
    return appended;
  });

  let unblocked: number[] = [];
  hashGuardedRewrite<TaskRecord[]>(tasksPath, (parsedTasks) => {
    const remaining = parsedTasks.filter((task) => !willClose.includes(task.taskNumber));
    unblocked = unblockDependents(remaining, willClose);
    return remaining;
  });

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
