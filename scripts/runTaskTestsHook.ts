// Runs this task's tests for /run-task-tests, typed as a prompt or invoked as the skill by an agent.
import { readFileSync } from "node:fs";
import { runTaskTests } from "./tackle-tasks/runTaskTests.ts";

let payload: { hook_event_name?: unknown; prompt?: unknown; tool_input?: Record<string, unknown> };
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

// Plugin skills reach the hook namespaced, as /taskTools:run-task-tests and taskTools:run-task-tests.
const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
const input = payload.tool_input ?? {};
const skill = String(input.skill ?? "").replace(/^[\w-]+:/, "");

const args = prompt.startsWith("/run-task-tests ")
  ? prompt.slice("/run-task-tests".length)
  : skill === "run-task-tests"
    ? String(input.args ?? "")
    : "";
// Quoted runs stay whole, so a worktree path with spaces survives.
const tokens = (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(token => token.replace(/^(["'])(.*)\1$/s, "$2"));
if (tokens.length === 0) process.exit(0);

const inject = (reason: string) => process.stdout.write(JSON.stringify({
  // Echoed from the payload: a name that disagrees with the firing event gets the output dropped.
  hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: reason },
}) + "\n");

const [taskNumber, runId, worktree, sourceBranch, projectRoot] = tokens;
if (tokens.length !== 5) {
  inject(`run-task-tests: expected 5 arguments, got ${tokens.length}: ${tokens.join(" ")}`);
  process.exit(0);
}

// The diagram box label, so a reconciled step result names the box it came from.
const result = runTaskTests(Number(taskNumber), runId, worktree, sourceBranch, "run task tests", projectRoot);
inject(JSON.stringify({ passed: result.passed }));
