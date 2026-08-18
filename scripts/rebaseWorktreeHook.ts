// Rebases the worktree for /rebase-worktree, typed as a prompt or invoked as the skill by an agent.
import { readFileSync } from "node:fs";
import { rebaseTaskWorktree } from "./tackle-tasks/rebaseTaskWorktree.ts";

let payload: { hook_event_name?: unknown; prompt?: unknown; tool_input?: Record<string, unknown> };
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

// Plugin skills reach the hook namespaced, as /taskTools:rebase-worktree and taskTools:rebase-worktree.
const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
const input = payload.tool_input ?? {};
const skill = String(input.skill ?? "").replace(/^[\w-]+:/, "");

const args = prompt.startsWith("/rebase-worktree ")
  ? prompt.slice("/rebase-worktree".length)
  : skill === "rebase-worktree"
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
  inject(`rebase-worktree: expected 5 arguments, got ${tokens.length}: ${tokens.join(" ")}`);
  process.exit(0);
}

// The script persists its own step receipt, so a lost answer is reconciled rather than replayed.
rebaseTaskWorktree({
  projectRoot, worktreePath, taskNumber: Number(taskNumber), runId, stepId: "rebase onto target branch", rootSourceBranch,
}).then((result) => inject(JSON.stringify({ conflicted: result.conflicted })));
