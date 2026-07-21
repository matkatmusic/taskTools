// Removes the given (just-closed) task numbers from every tasks.json entry's
// blockedBy array, dropping the field when it empties. Invoked by the
// close-tasks skill after moving closed tasks to completedTasks.json.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

const closed = new Set((process.argv.slice(2).join(" ").match(/\d+/g) ?? []).map(Number));
if (closed.size === 0) {
  process.stderr.write("usage: node unblockDependents.ts <taskNumber...>\n");
  process.exit(1);
}

const { tasksPath } = resolveTaskFiles(process.cwd());
const tasks = readTaskFile(tasksPath);
const unblocked: number[] = [];
for (const t of tasks) {
  if (!Array.isArray(t.blockedBy)) continue;
  const remaining = t.blockedBy.filter(n => !closed.has(Number(n)));
  if (remaining.length === t.blockedBy.length) continue;
  unblocked.push(t.taskNumber);
  if (remaining.length === 0) delete t.blockedBy;
  else t.blockedBy = remaining;
}
if (unblocked.length > 0) writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
process.stdout.write((unblocked.length > 0 ? `removed closed task(s) from blockedBy of task(s): ${unblocked.join(", ")}` : "no blockedBy references to the closed task(s)") + "\n");
