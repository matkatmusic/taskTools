// Stop hook: if this session modified files (flag set by turn-modified-flag.ts),
// point at COMMIT_MESSAGES.md once instead of dumping its contents into the chat.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
if (input.stop_hook_active) process.exit(0);
const sid = input.session_id;
if (typeof sid !== "string" || sid.length === 0) process.exit(0);

const flag = join(process.env.HOME ?? "", ".claude", "turn-flags", sid);
if (!existsSync(flag)) process.exit(0);
rmSync(flag); // consumed: the block fires once per file-modifying stretch

const instructionsPath = resolve(
  import.meta.dirname, "..", "skills", "tackle-tasks", "COMMIT_MESSAGES.md",
);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext:
      `If you changed files, read ${instructionsPath} and follow those directions.` +
      " If the changes are already staged and summarized, or nothing you changed is inside a git repo, say so briefly and stop.",
  },
}));
