// Removes closed task numbers from every tasks.json entry's blockedBy array, dropping the field when empty.
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
let migrated = false;
for (const t of tasks) {
  if (!Array.isArray(t.blockedBy)) continue;
  const entries = t.blockedBy as (number | { taskNum: number; reason: string })[];
  let taskMigrated = false;
  const upgraded = entries.map((entry) => {
    if (typeof entry === "number") {
      taskMigrated = true;
      return { taskNum: entry, reason: "reason not recorded (migrated from legacy blockedBy format)" };
    }
    return entry;
  });
  const remaining = upgraded.filter((entry) => !closed.has(entry.taskNum));
  const taskUnblocked = remaining.length !== upgraded.length;
  if (!taskMigrated && !taskUnblocked) continue;
  if (taskMigrated) migrated = true;
  if (taskUnblocked) unblocked.push(t.taskNumber);
  if (remaining.length === 0) delete t.blockedBy;
  else t.blockedBy = remaining;
}
if (unblocked.length > 0 || migrated) writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
process.stdout.write((unblocked.length > 0 ? `removed closed task(s) from blockedBy of task(s): ${unblocked.join(", ")}` : "no blockedBy references to the closed task(s)") + "\n");
