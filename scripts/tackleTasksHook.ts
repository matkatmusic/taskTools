// UserPromptSubmit hook: reports /tackle-tasks blockers and injects the skill body for the rest, so SKILL.md never re-runs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { leadingTaskNumbers } from "./taskFiles.ts";
import { tackleTasksBrief } from "./tackleTasksBrief.ts";

const checkBlockersPath = fileURLToPath(new URL("./checkBlockers.ts", import.meta.url));

type Blocker = { taskNum: number; reason: string };
type BlockerReport = { blockedTasks: Map<number, Blocker[]>; unblockedTasks: number[] };

function parseBlockerReport(output: string): BlockerReport {
  const blockedTasks = new Map<number, Blocker[]>();
  const unblockedTasks: number[] = [];
  for (const line of output.trim().split("\n")) {
    const blocked = line.match(/^task (\d+): BLOCKED by open task\(s\) (.+)$/);
    if (blocked) {
      blockedTasks.set(Number(blocked[1]), JSON.parse(blocked[2]) as Blocker[]);
      continue;
    }
    const unblocked = line.match(/^task (\d+): unblocked$/);
    if (unblocked) unblockedTasks.push(Number(unblocked[1]));
  }
  return { blockedTasks, unblockedTasks };
}

let payload: { prompt?: unknown; cwd?: unknown };
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
// Plugin skills reach the hook namespaced, as /taskTools:tackle-tasks.
const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
if (prompt !== "/tackle-tasks" && !prompt.startsWith("/tackle-tasks ")) process.exit(0);

const root = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
const tokens = prompt.slice("/tackle-tasks".length).trim().split(/\s+/).filter(Boolean);
const requested = leadingTaskNumbers(tokens);
if (requested.length === 0) process.exit(0);

let report: BlockerReport;
try {
  const output = execFileSync("node", [checkBlockersPath, JSON.stringify(requested)], { encoding: "utf8", cwd: root });
  report = parseBlockerReport(output);
} catch {
  process.exit(0);
}

const blockedLines: string[] = [];
const blockerNumbers: number[] = [];
for (const n of requested) {
  const blockers = report.blockedTasks.get(n);
  if (!blockers) continue;
  for (const b of blockers) {
    blockedLines.push(`[${n}] blocked by: ${b.taskNum}: ${b.reason}`);
    if (!blockerNumbers.includes(b.taskNum)) blockerNumbers.push(b.taskNum);
  }
}

const result: { decision: "block"; reason?: string; hookSpecificOutput?: { hookEventName: "UserPromptSubmit"; additionalContext: string } } = {
  decision: "block",
};
if (blockedLines.length > 0) {
  result.reason = [...blockedLines, `run 'tackle-tasks [${blockerNumbers.join(",")}] valid' first`].join("\n");
}
if (report.unblockedTasks.length > 0) {
  const splitIndex = tokens.findIndex(t => !/^["'[\]\d,]+$/.test(t));
  const trailing = splitIndex === -1 ? "" : tokens.slice(splitIndex).join(" ");
  const argsValue = JSON.stringify(report.unblockedTasks) + (trailing ? ` ${trailing}` : "");
  const blockedStatus = execFileSync("node", [checkBlockersPath, argsValue], { encoding: "utf8", cwd: root }).trimEnd();
  result.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: tackleTasksBrief(argsValue, blockedStatus) };
}
process.stdout.write(JSON.stringify(result) + "\n");
