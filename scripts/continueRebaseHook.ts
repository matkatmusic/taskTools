// Advances a stopped rebase for /continue-rebase, typed as a prompt or invoked as the skill by an agent.
import { readFileSync } from "node:fs";
import { advanceTaskRebase } from "./tackle-tasks/advanceTaskRebase.ts";
import { getCurrentTaskRun } from "./tackle-tasks/taskRunState.ts";

let payload: { hook_event_name?: unknown; prompt?: unknown; tool_input?: Record<string, unknown> };
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

// Plugin skills reach the hook namespaced, as /taskTools:continue-rebase and taskTools:continue-rebase.
const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
const input = payload.tool_input ?? {};
const skill = String(input.skill ?? "").replace(/^[\w-]+:/, "");

const args = prompt.startsWith("/continue-rebase ")
  ? prompt.slice("/continue-rebase".length)
  : skill === "continue-rebase"
    ? String(input.args ?? "")
    : "";
// Quoted runs stay whole, so a worktree path with spaces survives.
const tokens = (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(token => token.replace(/^(["'])(.*)\1$/s, "$2"));
if (tokens.length === 0) process.exit(0);

const inject = (reason: string) => process.stdout.write(JSON.stringify({
  // Echoed from the payload: a name that disagrees with the firing event gets the output dropped.
  hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: reason },
}) + "\n");

const [taskNumber, runId, worktreePath, rootSourceBranch, projectRoot] = tokens;
if (tokens.length !== 5) {
  inject(`continue-rebase: expected 5 arguments, got ${tokens.length}: ${tokens.join(" ")}`);
  process.exit(0);
}

// Derived here, never accepted from the caller: the rebase box recorded where it stopped.
const stopped = getCurrentTaskRun(Number(taskNumber), projectRoot)
  ?.stepResults?.findLast((receipt) => receipt.script === "rebaseTaskWorktree")?.result;
const stoppedAt = (stopped as { stoppedAt?: { occurrenceId: string; checkoutPath: string } } | undefined)?.stoppedAt;
if (!stoppedAt) {
  inject(`continue-rebase: task ${taskNumber} has no recorded stopped rebase; this box runs only after a rebase halted`);
  process.exit(0);
}

// The script persists its own step receipt, so a lost answer is reconciled rather than replayed.
const result = advanceTaskRebase({
  projectRoot, worktreePath, taskNumber: Number(taskNumber), runId, stepId: "continue the rebase", rootSourceBranch, stoppedAt,
});
inject(JSON.stringify({ finished: result.finished }));
