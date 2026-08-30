// Answers one task's clarifyRequest under the task-state lock: appends the answer to description, widens files, sets blockedBy, drops clarifyRequest, clears every run.history entry's attempts and countedPasses, and removes the worktree checkpoint so the next launch starts at the preamble instead of replaying the old CLARIFY packet.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { checkpointPath } from "./tackle-tasks/shared/checkpoint.ts";
import { readTaskFile, resolveTaskFiles, type TaskRecord } from "./taskFiles.ts";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";

export type ClarifyAnswer = {
  taskNumber: number;
  answer: string;
  files?: string[];
  blockedBy?: { taskNum: number; reason: string }[];
};

type HistoryRecord = { attempts?: unknown; countedPasses?: unknown } & Record<string, unknown>;

export function clarifyTask(input: ClarifyAnswer, projectRoot: string = process.cwd()): TaskRecord {
  const { tasksPath } = resolveTaskFiles(projectRoot);
  return withTaskStateLock(tasksPath, () => {
    const tasks = readTaskFile(tasksPath);
    const task = tasks.find((t) => t.taskNumber === input.taskNumber);
    if (task === undefined) throw new Error(`task ${input.taskNumber} is not an open task in ${tasksPath}`);
    if (typeof task.clarifyRequest !== "string" || task.clarifyRequest.trim() === "") {
      throw new Error(`task ${input.taskNumber} has no clarifyRequest to answer`);
    }
    const date = new Date().toISOString().slice(0, 10);
    task.description = `${task.description ?? ""}\n\n## Clarification answer (${date})\n\n${input.answer.trim()}`;
    const files = Array.isArray(task.files) ? (task.files as string[]) : [];
    task.files = [...files, ...(input.files ?? []).filter((f) => !files.includes(f))];
    if (input.blockedBy !== undefined) task.blockedBy = input.blockedBy;
    delete task.clarifyRequest;
    const run = task.run as { worktree?: unknown; history?: HistoryRecord[] } | undefined;
    for (const record of run?.history ?? []) {
      delete record.attempts;
      delete record.countedPasses;
    }
    if (typeof run?.worktree === "string" && existsSync(checkpointPath(run.worktree))) unlinkSync(checkpointPath(run.worktree));
    writeJsonAtomically(tasksPath, tasks);
    return task;
  });
}

function fail(problem: string): never {
  process.stderr.write(
    `clarifyTask: ${problem}\n` +
      `usage: node clarifyTask.ts <<'CLARIFYEOF'\n{"taskNumber": N, "answer": "...", "files": [...], "blockedBy": [{"taskNum": N, "reason": "..."}]}\nCLARIFYEOF\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("clarifyTask.ts")) {
  const raw = readFileSync(0, "utf8").trim();
  if (raw === "") fail("no answer JSON on stdin");
  const input = JSON.parse(raw) as ClarifyAnswer;
  if (typeof input.taskNumber !== "number" || typeof input.answer !== "string" || input.answer.trim() === "") {
    fail("taskNumber (number) and answer (non-empty string) are required");
  }
  const task = clarifyTask(input);
  process.stdout.write(`answered task ${task.taskNumber}; files: ${JSON.stringify(task.files)}; blockedBy: ${JSON.stringify(task.blockedBy ?? [])}; run attempts cleared; checkpoint removed\n`);
}
