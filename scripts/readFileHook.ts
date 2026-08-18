// Injects a file into context for /read-file <path>, typed as a prompt (UserPromptSubmit)
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

const path = prompt.startsWith("/read-file ")
  ? prompt.slice("/read-file".length).trim()
  : skill === "read-file"
    ? String(input.args ?? "").trim()
    : "";
if (!path) process.exit(0);

const reason = existsSync(path)
  ? `Contents of ${path}:\n\n${readFileSync(path, "utf8")}`
  : `read-file: no file at ${path}`;

// Echoed from the payload: a name that disagrees with the firing event gets the output dropped.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: payload.hook_event_name, additionalContext: reason },
}) + "\n");
