// Stop hook: reflow wrapped comments in this session's edited files, then flag any still-unstaged ones.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { emitReflows, reflowFile } from "./reflowComments.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
if (input.stop_hook_active) process.exit(0);
const sid = input.session_id;
if (typeof sid !== "string" || sid.length === 0) process.exit(0);

const flag = join(process.env.HOME ?? "", ".claude", "turn-flags", sid);
if (!existsSync(flag)) process.exit(0);
const paths = [...new Set(readFileSync(flag, "utf8").split("\n").filter(Boolean))];
rmSync(flag); // consumed: the reminder fires once per file-modifying stretch

const reflowed = paths.filter(existsSync).map((path) => ({ path, runs: reflowFile(path) }));

// Porcelain column two: space means staged, anything else means unstaged. Outside a repo, git throws — counts as clean.
const unstaged = paths.some((p) => {
  try {
    return execFileSync("git", ["-C", dirname(p), "status", "--porcelain", "--", p], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).split("\n").some((line) => line.length > 1 && line[1] !== " ");
  } catch {
    return false;
  }
});

// One JSON payload per invocation; the staging pointer waits for the next turn.
if (emitReflows("Stop", reflowed, sid)) process.exit(0);

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
