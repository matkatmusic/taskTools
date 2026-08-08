// Reports which requested task numbers are blocked by still-open tasks; stdout feeds a tackle-tasks !`node ...` command.
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

const pair = resolveTaskFiles(process.cwd());
const openTasks = readTaskFile(pair.tasksPath);
const openNumbers = new Set(openTasks.map(t => t.taskNumber));

// --unblocked: print only the unblocked task numbers, space-separated, so the skill preamble can pipe them straight into getTaskDetails.ts.
const unblockedOnly = process.argv.includes("--unblocked");
// No task numbers -> check every open task (mirrors getTaskDetails' no-arg listing).
const named = leadingTaskNumbers(process.argv.slice(2).filter(a => a !== "--unblocked"));
const requested = named.length > 0 ? named : openTasks.map(t => t.taskNumber);
const openBlockersOf = (n: number) => {
  const task = openTasks.find(t => t.taskNumber === n);
  const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number; reason: string }[]) : [];
  return blockedBy.filter(b => openNumbers.has(b.taskNum));
};

// Depth-first search with an in-progress set: a back edge into a task still "visiting" is a cycle.
function findCycle(): number[] | null {
  const state = new Map<number, "visiting" | "done">();
  const stack: number[] = [];
  const visit = (n: number): number[] | null => {
    state.set(n, "visiting");
    stack.push(n);
    for (const b of openBlockersOf(n)) {
      const seen = state.get(b.taskNum);
      if (seen === "visiting") return stack.slice(stack.indexOf(b.taskNum));
      if (seen !== "done") {
        const found = visit(b.taskNum);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(n, "done");
    return null;
  };
  for (const t of openTasks) {
    if (!state.has(t.taskNumber)) {
      const found = visit(t.taskNumber);
      if (found) return found;
    }
  }
  return null;
}

const cycle = findCycle();
if (cycle) {
  process.stderr.write(`cycle detected among open tasks: ${cycle.join(", ")}\n`);
  process.exit(1);
}

if (unblockedOnly) {
  process.stdout.write(requested.filter(n => openBlockersOf(n).length === 0).join(" ") + "\n");
} else {
  const lines = requested.map(n => {
    const blockers = openBlockersOf(n);
    return blockers.length > 0 ? `task ${n}: BLOCKED by open task(s) ${JSON.stringify(blockers)}` : `task ${n}: unblocked`;
  });
  process.stdout.write((lines.length > 0 ? lines.join("\n") : "no task numbers given") + "\n");
}
