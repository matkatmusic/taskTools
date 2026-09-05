// Stop hook: reflow this session's files, merge session deltas onto the index, then request a commit message.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { emitReflows, reflowFile } from "./reflowComments.ts";
import { REFLOW_EMITTED } from "./resultCodes.ts";

type Snapshot = { exists: boolean; contents?: string; mode?: number };

function snapshotPath(flagDir: string, sid: string, filePath: string): string {
  return join(flagDir, `${sid}.snapshots`, createHash("sha256").update(filePath).digest("hex"));
}

function stageSessionHunk(flagDir: string, sid: string, filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  let repo: string;
  try {
    repo = execFileSync("git", ["-C", dirname(filePath), "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return false;
  }
  const repoPath = relative(repo, realpathSync(filePath));
  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath(flagDir, sid, filePath), "utf8")) as Snapshot;
  } catch {
    return false;
  }
  if (!snapshot.exists) {
    try {
      execFileSync("git", ["-C", repo, "add", "--", repoPath], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  let indexed: Buffer;
  try {
    indexed = execFileSync("git", ["-C", repo, "show", `:${repoPath}`]);
  } catch {
    return false;
  }
  const scratch = mkdtempSync(join(tmpdir(), "stage-session-hunk-"));
  try {
    const ours = join(scratch, "index");
    const base = join(scratch, "snapshot");
    const theirs = join(scratch, "worktree");
    writeFileSync(ours, indexed);
    writeFileSync(base, Buffer.from(snapshot.contents ?? "", "base64"));
    writeFileSync(theirs, readFileSync(filePath));
    const merged = execFileSync("git", ["merge-file", "-p", ours, base, theirs]);
    const hash = execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: merged, encoding: "utf8" }).trim();
    const mode = (snapshot.mode ?? (statSync(filePath).mode & 0o777)) === 0o755 ? "100755" : "100644";
    execFileSync("git", ["-C", repo, "update-index", "--add", "--cacheinfo", `${mode},${hash},${repoPath}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const input = JSON.parse(readFileSync(0, "utf8"));
if (input.stop_hook_active) process.exit(0);
const sid = input.session_id;
if (typeof sid !== "string" || sid.length === 0) process.exit(0);

const flagDir = join(process.env.HOME ?? "", ".claude", "turn-flags");
const flag = join(flagDir, sid);
if (!existsSync(flag)) {
  process.stderr.write(`No modified-file list for session ${sid}; staging nothing.\n`);
  process.exit(0);
}
let paths: string[];
try {
  paths = [...new Set(readFileSync(flag, "utf8").split("\n").filter(Boolean))];
} catch {
  process.stderr.write(`Could not read modified-file list for session ${sid}; staging nothing.\n`);
  process.exit(0);
}

const reflowed = paths.filter(existsSync).map((path) => ({ path, runs: reflowFile(path) }));

// Keep the state for the reflow-triggered Stop invocation; it performs the staging pass.
if (emitReflows("Stop", reflowed, sid) === REFLOW_EMITTED) process.exit(0);

const staged = paths.filter((path) => stageSessionHunk(flagDir, sid, path));
rmSync(flag, { force: true });
rmSync(join(flagDir, `${sid}.snapshots`), { recursive: true, force: true });
if (staged.length === 0) process.exit(0);
// process.stdout.write(JSON.stringify({
//   hookSpecificOutput: {
//     hookEventName: "Stop",
//     additionalContext: "This session's changes are staged. Do not commit; invoke the commit-message skill.",
//   },
// }));
