// Moves task numbers from tasks.json to completedTasks.json with a closure note and commit hashes.
import { readFileSync } from "node:fs";
import { leadingTaskNumbers, resolveTaskFiles } from "../shared/taskFiles.ts";
import type { TaskFilePair, TaskRecord } from "../shared/taskFiles.ts";
import { unblockDependents } from "../shared/unblockDependents.ts";
import { withTaskStateLock, writeJsonAtomically } from "../shared/taskStateLock.ts";
import { ARCHIVE_MALFORMED, ARCHIVE_WELL_FORMED } from "../shared/resultCodes.ts";
import type { StepResultReceipt, TaskRunRecord, TaskRunState } from "../tackle-tasks/shared/taskRunState.ts";

export interface CloseTasksResult {
  closed: number[];
  skipped: number[];
  unblocked: number[];
}

// F12: closeTaskRun's output. `ambiguous` differs from `skipped` — evidence disagreeing is never mistaken for evidence absent entirely.
export interface CloseTaskRunOutput {
  closed: number[];
  skipped: number[];
  ambiguous: number[];
  unblocked: number[];
}

export type ArchivedTaskRecord = TaskRecord & { run?: TaskRunState; closureNote?: unknown; commitHashes?: unknown };

const EMPTY_TASK_RUN_STATE: TaskRunState = { active: false, worktree: null, leaseRunId: null, history: [] };

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
  { onAcquired }: { onAcquired?: () => void } = {},
): CloseTasksResult {
  const pair = resolveTaskFiles(projectRoot);
  return withTaskStateLock(pair.tasksPath, () =>
    closeTasksLocked(taskNumbers, closureNote, pair, commitHashes), { onAcquired });
}

// F6's checked archive: eligibility from task.run under the same lock as the write; hashes are derived, never caller-supplied.
export function closeTaskRunChecked(
  taskNumber: number,
  runId: string,
  closureNote: string,
  projectRoot: string = process.cwd(),
): CloseTasksResult {
  const pair = resolveTaskFiles(projectRoot);
  return withTaskStateLock(pair.tasksPath, () => {
    const tasks = JSON.parse(readFileSync(pair.tasksPath, "utf8")) as (TaskRecord & { run?: TaskRunState })[];
    const task = tasks.find((t) => t.taskNumber === taskNumber);
    if (task === undefined) throw new Error(`closeTaskRunChecked: task ${taskNumber} not found`);
    const state = task.run ?? EMPTY_TASK_RUN_STATE;
    const newest = state.history[state.history.length - 1];
    if (
      state.active || newest === undefined || newest.runId !== runId
      || newest.endedAt === null || newest.exitType !== "completed"
    ) {
      throw new Error(`closeTaskRunChecked: task ${taskNumber} has no ended, completed run "${runId}" to archive`);
    }
    const commitHashes = newest.commits.map((commit) => commit.hash);
    return closeTasksLocked([taskNumber], closureNote, pair, commitHashes);
  });
}

// The ended, completed history entry for runId, if the record has one at all.
function findEndedRunEntry(record: ArchivedTaskRecord, runId: string): TaskRunRecord | undefined {
  return record.run?.history.find(
    (candidate) => candidate.runId === runId && candidate.endedAt !== null && candidate.exitType === "completed",
  );
}

function chronologicalHashes(record: TaskRunRecord): string[] {
  return record.commits.map((commit) => commit.hash);
}

function requireEndedCompletedRun(state: TaskRunState, runId: string, taskNumber: number): TaskRunRecord {
  const newest = state.history[state.history.length - 1];
  if (
    state.active || newest === undefined || newest.runId !== runId
    || newest.endedAt === null || newest.exitType !== "completed"
  ) {
    throw new Error(`closeTaskRun: task ${taskNumber} has no ended, completed run "${runId}" to archive`);
  }
  return newest;
}

function archiveIsWellFormed(archived: ArchivedTaskRecord): number {
  const wellFormed = typeof archived.closureNote === "string"
    && Array.isArray(archived.commitHashes)
    && (archived.commitHashes as unknown[]).every((hash) => typeof hash === "string");
  return wellFormed ? ARCHIVE_WELL_FORMED : ARCHIVE_MALFORMED;
}

// Shared with reconcileStep.ts's reconcileCloseTaskRun so this rule can't drift; requires an EXACT match of run identity, note, hashes.
export function validateArchivedRun(
  archived: ArchivedTaskRecord, runId: string, closureNote: string,
): TaskRunRecord | null {
  const ended = findEndedRunEntry(archived, runId);
  if (ended === undefined) return null;
  if (archiveIsWellFormed(archived) !== ARCHIVE_WELL_FORMED) return null;
  if (archived.closureNote !== closureNote) return null;
  if (JSON.stringify(archived.commitHashes) !== JSON.stringify(chronologicalHashes(ended))) return null;
  return ended;
}

// Only-completed: success requires an EXACT match of run identity, note, hashes; anything else is ambiguity, not "not found".
function reconcileArchivedOnly(
  archived: ArchivedTaskRecord, taskNumber: number, runId: string, closureNote: string,
): CloseTaskRunOutput {
  if (validateArchivedRun(archived, runId, closureNote) !== null) {
    return { closed: [taskNumber], skipped: [], ambiguous: [], unblocked: [] };
  }
  return { closed: [], skipped: [], ambiguous: [taskNumber], unblocked: [] };
}

// Both files, same run: archived record is immutable evidence; only open record removal/unblocking happens, completedTasks.json untouched.
function archiveOpenTaskRemovalOnly(
  tasks: TaskRecord[], archived: ArchivedTaskRecord, taskNumber: number, runId: string, pair: TaskFilePair,
): CloseTaskRunOutput {
  const ended = findEndedRunEntry(archived, runId);
  if (ended === undefined) {
    throw new Error(`closeTaskRun: task ${taskNumber} is archived under a different run than "${runId}"`);
  }
  if (archiveIsWellFormed(archived) !== ARCHIVE_WELL_FORMED) {
    throw new Error(`closeTaskRun: task ${taskNumber}'s archived record is malformed and cannot be trusted`);
  }
  const remaining = tasks.filter((task) => task.taskNumber !== taskNumber);
  const unblocked = unblockDependents(remaining, [taskNumber]);
  writeJsonAtomically(pair.tasksPath, remaining);
  return { closed: [taskNumber], skipped: [], ambiguous: [], unblocked };
}

// F10: writes the real return value of a fresh archive-and-close call onto run.history; not used for reused archives.
function persistCloseStepReceipt(
  completedTasksPath: string, taskNumber: number, runId: string, stepId: string, result: CloseTaskRunOutput,
): void {
  const completed = JSON.parse(readFileSync(completedTasksPath, "utf8")) as ArchivedTaskRecord[];
  const index = completed.findIndex((task) => task.taskNumber === taskNumber);
  if (index === -1) throw new Error(`closeTaskRun: task ${taskNumber} was not found in the archive it just wrote`);
  const archived = completed[index];
  const state = archived.run ?? EMPTY_TASK_RUN_STATE;
  const historyIndex = state.history.findIndex((run) => run.runId === runId);
  if (historyIndex === -1) throw new Error(`closeTaskRun: archived run history for task ${taskNumber} has no entry for "${runId}"`);
  const record = state.history[historyIndex];
  const receipt: StepResultReceipt = { stepId, script: "closeTaskRun", result };
  const stepResults = [...(record.stepResults ?? []).filter((existing) => existing.stepId !== stepId), receipt];
  const nextHistory = [...state.history];
  nextHistory[historyIndex] = { ...record, stepResults };
  completed[index] = { ...archived, run: { ...state, history: nextHistory } };
  writeJsonAtomically(completedTasksPath, completed);
}

// F12: the single locked transaction behind closeTaskRun.ts, covering all four presence cases from one read of both task files.
export function closeTaskRunReconciled(
  taskNumber: number,
  runId: string,
  closureNote: string,
  projectRoot: string,
  stepId: string,
): CloseTaskRunOutput {
  const pair = resolveTaskFiles(projectRoot);
  return withTaskStateLock(pair.tasksPath, () => {
    const tasks = JSON.parse(readFileSync(pair.tasksPath, "utf8")) as (TaskRecord & { run?: TaskRunState })[];
    const completed = JSON.parse(readFileSync(pair.completedTasksPath, "utf8")) as ArchivedTaskRecord[];
    const openTask = tasks.find((task) => task.taskNumber === taskNumber);
    const archived = completed.find((task) => task.taskNumber === taskNumber);

    if (openTask === undefined && archived === undefined) {
      return { closed: [], skipped: [taskNumber], ambiguous: [], unblocked: [] };
    }
    if (openTask === undefined) {
      return reconcileArchivedOnly(archived!, taskNumber, runId, closureNote);
    }
    if (archived !== undefined) {
      return archiveOpenTaskRemovalOnly(tasks, archived, taskNumber, runId, pair);
    }

    const state = (openTask as ArchivedTaskRecord).run ?? EMPTY_TASK_RUN_STATE;
    const newest = requireEndedCompletedRun(state, runId, taskNumber);
    const result = closeTasksLocked([taskNumber], closureNote, pair, chronologicalHashes(newest));
    const output: CloseTaskRunOutput = { ...result, ambiguous: [] };
    persistCloseStepReceipt(pair.completedTasksPath, taskNumber, runId, stepId, output);
    return output;
  });
}

export function closeTasksLocked(
  taskNumbers: number[],
  closureNote: string | Record<number, string>,
  pair: TaskFilePair,
  commitHashes: string[] | Record<number, string[]>,
): CloseTasksResult {
  const { tasksPath, completedTasksPath } = pair;
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
