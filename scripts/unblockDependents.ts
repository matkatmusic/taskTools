// Removes closed task numbers from blockedBy arrays; CLI below re-reads/rewrites tasks.json standalone.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export function unblockDependents(tasks: any[], closedTaskNumbers: number[]): number[] {
  const closed = new Set(closedTaskNumbers.map(Number));
  const unblocked: number[] = [];
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
    if (taskUnblocked) unblocked.push(t.taskNumber);
    if (remaining.length === 0) delete t.blockedBy;
    else t.blockedBy = remaining;
  }
  return unblocked;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const closed = new Set((process.argv.slice(2).join(" ").match(/\d+/g) ?? []).map(Number));
  if (closed.size === 0) {
    process.stderr.write("usage: node unblockDependents.ts <taskNumber...>\n");
    process.exit(1);
  }

  const { tasksPath } = resolveTaskFiles(process.cwd());
  const tasks = readTaskFile(tasksPath);
  const before = JSON.stringify(tasks);
  const unblocked = unblockDependents(tasks, [...closed]);
  if (JSON.stringify(tasks) !== before) writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
  process.stdout.write((unblocked.length > 0 ? `removed closed task(s) from blockedBy of task(s): ${unblocked.join(", ")}` : "no blockedBy references to the closed task(s)") + "\n");
}
