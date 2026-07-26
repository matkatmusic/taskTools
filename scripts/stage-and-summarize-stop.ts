// Stop hook: if this session left any of the files it modified unstaged
// (list recorded by turn-modified-flag.ts), point at COMMIT_MESSAGES.md once
// instead of dumping its contents into the chat. Silent otherwise.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8"));
if (input.stop_hook_active) process.exit(0);
const sid = input.session_id;
if (typeof sid !== "string" || sid.length === 0) process.exit(0);

const flag = join(process.env.HOME ?? "", ".claude", "turn-flags", sid);
if (!existsSync(flag)) process.exit(0);
const paths = [...new Set(readFileSync(flag, "utf8").split("\n").filter(Boolean))];
rmSync(flag); // consumed: the reminder fires once per file-modifying stretch

// Nothing to say unless one of those files still has unstaged work. A porcelain
// line's second column is the worktree status: space means staged-and-clean,
// anything else (including "??") means the user still has staging to do.
// Paths outside a git repo throw and count as clean — nothing to stage there.
const unstaged = paths.some((p) => {
  try {
    return execFileSync("git", ["-C", dirname(p), "status", "--porcelain", "--", p], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).split("\n").some((line) => line.length > 1 && line[1] !== " ");
  } catch {
    return false;
  }
});
if (!unstaged) process.exit(0);

const instructionsPath = resolve(
  import.meta.dirname, "..", "skills", "tackle-tasks", "COMMIT_MESSAGES.md",
);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext:
      `Files were changed, read ${instructionsPath} and follow those directions.`,
  },
}));
