// UPDATE_TASKS_JSON, from pipeline-reviewPlan.mmd. Mutating: writes codex's notes into tasks.json and resets the planReview counter.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCRIPT_SIGNAL } from "../../shared/contracts.ts";
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "../../shared/taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "../../shared/taskStateLock.ts";
import { raiseAttemptCount, resetAttemptCount } from "../shared/taskRunState.ts";
import { readCheckpoint } from "../shared/checkpoint.ts";
import type { WhatIsReviewVerdictPacket } from "./_packet.ts";

type Input = WhatIsReviewVerdictPacket & { verdict: string; notes: string };

function writeCodexReviewNotes(projectRoot: string, taskNumber: number, notes: string): void {
  const pair = resolveTaskFiles(projectRoot);
  withTaskStateLock(pair.tasksPath, () => {
    const tasks = readTaskFile(pair.tasksPath);
    let entry: TaskRecord | undefined;
    for (const task of tasks) {
      const isMatch = task.taskNumber === taskNumber;
      if (isMatch) {
        entry = task;
        break;
      }
    }
    if (entry === undefined)
      throw new Error(`task ${taskNumber} not found in ${pair.tasksPath}`);
    entry.codexReviewNotes = notes;
    writeJsonAtomically(pair.tasksPath, tasks);
  });
}

export function main(input: string): Record<string, unknown> {
  const packet = JSON.parse(input) as Input;
  writeCodexReviewNotes(packet.projectRoot, packet.taskNumber, packet.notes);
  // const checkpoint = readCheckpoint(packet.worktree);
  // if (checkpoint === null) throw new Error(`UPDATE_TASKS_JSON: no checkpoint in ${packet.worktree}`);
  // raiseAttemptCount(packet.taskNumber, packet.runId, "planReview", checkpoint.passId, packet.projectRoot);
  resetAttemptCount(packet.taskNumber, packet.runId, "planReview", packet.projectRoot);
  return { ...packet, box: "UPDATE_TASKS_JSON", scriptSignal: SCRIPT_SIGNAL.CONTINUE };
}

// realpathSync on both sides: a symlinked folder makes argv[1] and import.meta.url disagree.
const scriptPath = realpathSync(process.argv[1]!);
const modulePath = realpathSync(fileURLToPath(import.meta.url));
const isMainModule = scriptPath === modulePath;
if (isMainModule)
  console.log(JSON.stringify(main(process.argv[2] ?? "")));
