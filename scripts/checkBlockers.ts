// Reports which requested task numbers are blocked by still-open tasks; stdout feeds a tackle-tasks !`node ...` command.
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export function blockerReport(requestedNumbers: number[], projectRoot: string = process.cwd()): {
  requested: number[];
  openBlockersOf: (n: number) => { taskNum: number; reason: string }[];
  blockerPairs: { blockedTask: number; blockerTask: number; reason: string }[];
  unblockedNumbers: number[];
} {
  const pair = resolveTaskFiles(projectRoot);
  const openTasks = readTaskFile(pair.tasksPath);
  const openNumbers = new Set(openTasks.map(t => t.taskNumber));
  // No task numbers -> check every open task (mirrors getTaskDetails' no-arg listing).
  const requested = requestedNumbers.length > 0 ? requestedNumbers : openTasks.map(t => t.taskNumber);
  const openBlockersOf = (n: number) => {
    const task = openTasks.find(t => t.taskNumber === n);
    const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number; reason: string }[]) : [];
    return blockedBy.filter(b => openNumbers.has(b.taskNum));
  };
  const blockerPairs = requested.flatMap(n => openBlockersOf(n).map(b => ({ blockedTask: n, blockerTask: b.taskNum, reason: b.reason })));
  const unblockedNumbers = requested.filter(n => openBlockersOf(n).length === 0);
  return { requested, openBlockersOf, blockerPairs, unblockedNumbers };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // --unblocked: print only the unblocked task numbers, space-separated, so the skill preamble can pipe them straight into getTaskDetails.ts.
  const unblockedOnly = process.argv.includes("--unblocked");
  const named = leadingTaskNumbers(process.argv.slice(2).filter(a => a !== "--unblocked"));
  const { requested, openBlockersOf, unblockedNumbers } = blockerReport(named);
  if (unblockedOnly) {
    process.stdout.write(unblockedNumbers.join(" ") + "\n");
  } else {
    const lines = requested.map(n => {
      const blockers = openBlockersOf(n);
      return blockers.length > 0 ? `task ${n}: BLOCKED by open task(s) ${JSON.stringify(blockers)}` : `task ${n}: unblocked`;
    });
    process.stdout.write((lines.length > 0 ? lines.join("\n") : "no task numbers given") + "\n");
  }
}
