// PostToolUse (Edit|Write|NotebookEdit): record which files this session
// modified. The Stop hook (stage-and-summarize-stop.ts) consumes the list and
// only speaks up if some of those paths are still unstaged.
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (typeof input.session_id === "string" && input.session_id.length > 0 && path) {
  const dir = join(process.env.HOME ?? "", ".claude", "turn-flags");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, input.session_id), `${path}\n`);
}
