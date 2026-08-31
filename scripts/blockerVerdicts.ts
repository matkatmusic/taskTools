// Single source of truth for blocker verdicts: allowed values, investigation prompt, and the strip-entry CLI.
import { readFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";
import { BLOCKER_ENTRY_NOT_FOUND, BLOCKER_ENTRY_REMOVED } from "./resultCodes.ts";

export const BLOCKER_VERDICTS = { DISPROVEN: "disproven", STILL_BLOCKED: "still-blocked" } as const;
export const BLOCKER_VERDICT_VALUES = Object.values(BLOCKER_VERDICTS);
export type BlockerVerdict = typeof BLOCKER_VERDICT_VALUES[number];

export const BLOCKER_VERDICT_SCHEMA_FRAGMENT = { type: "string", enum: [...BLOCKER_VERDICT_VALUES] };

export function buildBlockerInvestigationPrompt(blockedTask: number, blockerTask: number, reason: string): string {
  return `Find out if task ${blockedTask} is actually blocked by task ${blockerTask} due to: ${reason}`;
}

export function stripDisprovenBlocker(tasks: any[], blockedTaskNumber: number, blockerTaskNumber: number, reason: string): number {
  const task = tasks.find(t => t.taskNumber === blockedTaskNumber);
  const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number; reason: string }[]) : [];
  const index = blockedBy.findIndex(b => b.taskNum === blockerTaskNumber && b.reason === reason);
  if (index === -1) return BLOCKER_ENTRY_NOT_FOUND;
  const remaining = [...blockedBy.slice(0, index), ...blockedBy.slice(index + 1)];
  if (remaining.length === 0) delete task.blockedBy;
  else task.blockedBy = remaining;
  return BLOCKER_ENTRY_REMOVED;
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [blockedArg, blockerArg] = process.argv.slice(2);
  const blockedTaskNumber = Number(blockedArg);
  const blockerTaskNumber = Number(blockerArg);
  if (!Number.isFinite(blockedTaskNumber) || !Number.isFinite(blockerTaskNumber)) {
    process.stderr.write(
      "usage: node blockerVerdicts.ts <blockedTaskNumber> <blockerTaskNumber> <<'BLOCKERREASONEOF'\n<reason>\nBLOCKERREASONEOF\n",
    );
    process.exit(1);
  }
  const reason = readStdin().replace(/\n$/, "");

  const pair = resolveTaskFiles(process.cwd());
  const removed = withTaskStateLock(pair.tasksPath, () => {
    const { tasksPath } = pair;
    const tasks = readTaskFile(tasksPath);
    const didRemove = stripDisprovenBlocker(tasks, blockedTaskNumber, blockerTaskNumber, reason);
    if (didRemove === BLOCKER_ENTRY_REMOVED) writeJsonAtomically(tasksPath, tasks);
    return didRemove;
  });
  process.stdout.write((removed === BLOCKER_ENTRY_REMOVED
    ? `removed blockedBy entry from task ${blockedTaskNumber} for blocker task ${blockerTaskNumber}`
    : `no matching blockedBy entry for task ${blockedTaskNumber} blocked by task ${blockerTaskNumber} with that reason`) + "\n");
}
