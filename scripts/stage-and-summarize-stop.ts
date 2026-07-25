// Stop hook: if this session modified files (flag set by turn-modified-flag.ts),
// block the stop once and inject the staging/commit-message instructions.
// The instruction text is single-sourced from taskTools' COMMIT_MESSAGES.md.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
if (input.stop_hook_active) process.exit(0);
const sid = input.session_id;
if (typeof sid !== "string" || sid.length === 0) process.exit(0);

const flag = join(process.env.HOME ?? "", ".claude", "turn-flags", sid);
if (!existsSync(flag)) process.exit(0);
rmSync(flag); // consumed: the block fires once per file-modifying stretch

const instructionsPath = join(
  import.meta.dirname, "..", "skills", "tackle-tasks", "COMMIT_MESSAGES.md",
);
// ponytail: fallback keeps the hook working if COMMIT_MESSAGES.md is renamed
let instructions =
  "Stage the changes in each affected repo (git add; do NOT commit in any repo) " +
  "and report one short single-sentence commit message per repo as: " +
  "Repo: <repo name>" +
  "Message: <summary>.";
try {
  instructions = readFileSync(instructionsPath, "utf8");
} catch {}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext:
      "You changed files this turn. " + instructions +
      "\nIf the changes are already staged and summarized, or nothing you changed is inside a git repo, say so briefly and stop.",
  },
}));
