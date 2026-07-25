// PostToolUse (Edit|Write|NotebookEdit): mark this session as having modified
// files. The Stop hook (stage-and-summarize-stop.ts) consumes the flag.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
if (typeof input.session_id === "string" && input.session_id.length > 0) {
  const dir = join(process.env.HOME ?? "", ".claude", "turn-flags");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, input.session_id), "");
}
