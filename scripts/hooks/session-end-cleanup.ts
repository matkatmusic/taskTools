// SessionEnd: delete this session's quota and turn-flag state, then sweep orphans from crashed sessions.
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function pruneFilesOlderThanSevenDays(dir: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > SEVEN_DAYS_MS) rmSync(path, { force: true });
    } catch {}
  }
}

const input = JSON.parse(readFileSync(0, "utf8"));
const claudeDir = join(process.env.HOME ?? "", ".claude");
const quotaDir = join(claudeDir, "comment-quota");
const turnFlagsDir = join(claudeDir, "turn-flags");

if (typeof input.session_id === "string") {
  if (input.session_id.length > 0) {
    rmSync(join(quotaDir, `${input.session_id}.json`), { force: true });
    rmSync(join(turnFlagsDir, input.session_id), { force: true });
  }
}
pruneFilesOlderThanSevenDays(quotaDir);
pruneFilesOlderThanSevenDays(turnFlagsDir);
