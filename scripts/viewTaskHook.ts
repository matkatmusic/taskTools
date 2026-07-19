// UserPromptSubmit hook: intercepts "/view-task <N...>" and answers it directly with a
// block-decision JSON ({"decision":"block","reason":<text>}), so the prompt never reaches
// the model — zero token cost. The point is readability: tasks.json stores descriptions
// as JSON-escaped one-liners; the block reason prints them with real newlines.
// Any other prompt: exit 0 with empty stdout (silent passthrough).
import { readFileSync } from "node:fs";
import { type TaskRecord, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

function formatTask(task: TaskRecord, status: string): string {
  const lines = [`Task ${task.taskNumber} (${status}): ${task.title ?? ""}`];
  if (task.description) lines.push("", String(task.description));
  const extras = Object.entries(task).filter(([key]) => !["taskNumber", "title", "description"].includes(key));
  if (extras.length > 0) lines.push("");
  for (const [key, value] of extras) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`, ...value.map(item => `  - ${item}`));
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join("\n");
}

function describeTask(taskNumber: number, openTasks: TaskRecord[], completedTasks: TaskRecord[]): string {
  const open = openTasks.find(t => t.taskNumber === taskNumber);
  if (open) return formatTask(open, "OPEN");
  const completed = completedTasks.find(t => t.taskNumber === taskNumber);
  if (completed) return formatTask(completed, "COMPLETED");
  return `Task ${taskNumber}: not found in tasks.json or completedTasks.json`;
}

let payload: { prompt?: unknown; cwd?: unknown };
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const prompt = typeof payload.prompt === "string" ? payload.prompt.trimStart() : "";
if (prompt !== "/view-task" && !prompt.startsWith("/view-task ")) process.exit(0);

const root = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
const pair = resolveTaskFiles(root);
const openTasks = readTaskFile(pair.tasksPath);
const completedTasks = readTaskFile(pair.completedTasksPath);

const numbers = (prompt.slice("/view-task".length).match(/\d+/g) ?? []).map(Number);
const reason =
  numbers.length === 0
    ? `Usage: /view-task <N...>\n\nOpen tasks:\n${openTasks.map(t => `  ${t.taskNumber}: ${t.title ?? ""}`).join("\n")}`
    : numbers.map(n => describeTask(n, openTasks, completedTasks)).join("\n\n");
process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
