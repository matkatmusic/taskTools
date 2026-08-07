// Single source of truth for blocker verdicts: allowed values, investigation prompt, reason tokens, and the strip-entry CLI.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export const BLOCKER_VERDICTS = { DISPROVEN: "disproven", STILL_BLOCKED: "still-blocked" } as const;
export const BLOCKER_VERDICT_VALUES = Object.values(BLOCKER_VERDICTS);
export type BlockerVerdict = typeof BLOCKER_VERDICT_VALUES[number];

export const BLOCKER_VERDICT_SCHEMA_FRAGMENT = { type: "string", enum: [...BLOCKER_VERDICT_VALUES] };

export function buildBlockerInvestigationPrompt(blockedTask: number, blockerTask: number, reason: string): string {
  return `Find out if task ${blockedTask} is actually blocked by task ${blockerTask} due to: ${reason}`;
}

export function encodeBlockerReasonToken(reason: string): string {
  return "r" + Buffer.from(reason, "utf8").toString("base64url");
}

export function decodeBlockerReasonToken(token: string): string {
  return Buffer.from(token.slice(1), "base64url").toString("utf8");
}

export function stripDisprovenBlocker(tasks: any[], blockedTaskNumber: number, blockerTaskNumber: number, reason: string): boolean {
  const task = tasks.find(t => t.taskNumber === blockedTaskNumber);
  const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number; reason: string }[]) : [];
  const index = blockedBy.findIndex(b => b.taskNum === blockerTaskNumber && b.reason === reason);
  if (index === -1) return false;
  const remaining = [...blockedBy.slice(0, index), ...blockedBy.slice(index + 1)];
  if (remaining.length === 0) delete task.blockedBy;
  else task.blockedBy = remaining;
  return true;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [blockedArg, blockerArg, reasonTokenArg] = process.argv.slice(2);
  const blockedTaskNumber = Number(blockedArg);
  const blockerTaskNumber = Number(blockerArg);
  if (!Number.isFinite(blockedTaskNumber) || !Number.isFinite(blockerTaskNumber) || !reasonTokenArg || !/^r[A-Za-z0-9_-]*$/.test(reasonTokenArg)) {
    process.stderr.write("usage: node blockerVerdicts.ts <blockedTaskNumber> <blockerTaskNumber> <reasonToken>\n");
    process.exit(1);
  }
  const reason = decodeBlockerReasonToken(reasonTokenArg);

  const { tasksPath } = resolveTaskFiles(process.cwd());
  const tasks = readTaskFile(tasksPath);
  const removed = stripDisprovenBlocker(tasks, blockedTaskNumber, blockerTaskNumber, reason);
  if (removed) writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
  process.stdout.write((removed
    ? `removed blockedBy entry from task ${blockedTaskNumber} for blocker task ${blockerTaskNumber}`
    : `no matching blockedBy entry for task ${blockedTaskNumber} blocked by task ${blockerTaskNumber} with that reason`) + "\n");
}
