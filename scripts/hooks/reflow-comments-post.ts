// PostToolUse (Edit|Write): reflow wrapped comments in the file just written, before the agent moves on.
import { existsSync, readFileSync } from "node:fs";
import { emitReflows, reflowFile } from "./reflowComments.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
const path = input.tool_input?.file_path;
if (typeof path !== "string" || !existsSync(path)) process.exit(0);

emitReflows("PostToolUse", [{ path, runs: reflowFile(path) }], input.session_id);
