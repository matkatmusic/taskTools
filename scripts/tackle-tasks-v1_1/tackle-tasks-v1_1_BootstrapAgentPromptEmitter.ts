import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { blockerReport } from "../shared/checkBlockers.ts";
import { readTaskLists } from "../shared/getTaskDetails.ts";
import { leadingTaskNumbers } from "../shared/taskFiles.ts";
import { TASKS_PER_COMMAND } from "../hooks/taskStats.ts";

const prepareTasksPath = fileURLToPath(new URL("../shared/prepareTasks.ts", import.meta.url));

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function fail(problem: string): never {
  process.stderr.write(`tackle-tasks_BootstrapAgentPromptEmitter: ${problem}\n`);
  process.exit(1);
}

function printResult(json: unknown) {
  process.stdout.write(`Return exactly this JSON as your structured result, with no other keys added or removed:\n${JSON.stringify(json)}\n`);
}

function requestedNumbers(argsValue: string): number[] {
  return leadingTaskNumbers(argsValue.split(/\s+/));
}

function modeDiscover(argsValue: string) {
  const { blockerPairs, unblockedNumbers } = blockerReport(requestedNumbers(argsValue));
  printResult({ blockerPairs, unblockedNumbers });
}

function modePrepare(argsValue: string) {
  const { unblockedNumbers } = blockerReport(requestedNumbers(argsValue));
  const { openTasks, completedTasks } = readTaskLists(process.cwd());
  const taskDetails = unblockedNumbers.map((n) => {
    const open = openTasks.find((t) => t.taskNumber === n);
    if (open) return { number: n, status: "open" as const, task: open };
    const completed = completedTasks.find((t) => t.taskNumber === n);
    if (completed) return { number: n, status: "completed" as const, task: completed };
    return { number: n, status: "not-found" as const, task: null };
  });
  const openNumbers = taskDetails.filter((d) => d.status === "open").map((d) => d.number);
  // prepareTasks.ts hard-fails on any requested number that isn't open, so only verified-open numbers reach it.
  const pipelineArgs = openNumbers.length === 0
    ? { groups: [] }
    : JSON.parse(execFileSync("node", [prepareTasksPath, JSON.stringify(openNumbers)], { encoding: "utf8" }));
  printResult({ taskDetails, pipelineArgs, maxConcurrency: TASKS_PER_COMMAND });
}

if (process.argv[1]?.endsWith("tackle-tasks-v1_1_BootstrapAgentPromptEmitter.ts")) {
  const mode = process.argv[2];
  const argsValue = readStdin().replace(/\n$/, "");
  if (argsValue === "") fail("no arguments on stdin");
  if (mode === "discover") modeDiscover(argsValue);
  else if (mode === "prepare") modePrepare(argsValue);
  else fail(`unknown mode "${mode}"; expected "discover" or "prepare"`);
}
