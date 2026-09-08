// PostToolUse (Edit|Write): reflow wrapped comments in the file just written. Never blocks; the Stop hook asks for rewrites.
import { existsSync, readFileSync } from "node:fs";
import { describeReflows, reflowFile } from "./reflowComments.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
const path = input.tool_input?.file_path;
if (typeof path !== "string" || !existsSync(path)) process.exit(0);

const runs = reflowFile(path);
if (!runs.some((run) => run.joined)) process.exit(0);
process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: describeReflows([{ path, runs }], []) },
})}\n`);
