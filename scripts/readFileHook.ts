// Injects files into context for /read-file <path...>, typed as a prompt (UserPromptSubmit)
// or invoked as the read-file skill by an agent (PostToolUse on the Skill tool).
import { existsSync, readFileSync } from "node:fs";

let payload: { hook_event_name?: unknown; prompt?: unknown; tool_input?: Record<string, unknown> };
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

// Plugin skills reach the hook namespaced, as /taskTools:read-file and taskTools:read-file.
const prompt = (typeof payload.prompt === "string" ? payload.prompt.trimStart() : "").replace(/^\/[\w-]+:/, "/");
const input = payload.tool_input ?? {};
const skill = String(input.skill ?? "").replace(/^[\w-]+:/, "");

const args = prompt.startsWith("/read-file ")
  ? prompt.slice("/read-file".length)
  : skill === "read-file"
    ? String(input.args ?? "")
    : "";
// Quoted runs stay whole, so a path with spaces survives.
const paths = (args.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(token => token.replace(/^(["'])(.*)\1$/s, "$2"));
if (paths.length === 0) process.exit(0);

const reason = paths
  .map(path => `==== ${path} ====\n${existsSync(path) ? readFileSync(path, "utf8") : `read-file: no file at ${path}`}`)
  .join("\n\n");

// Echoed from the payload: a name that disagrees with the firing event gets the output dropped.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: reason },
}) + "\n");
