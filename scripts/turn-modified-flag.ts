// PreToolUse saves each path's first session state; PostToolUse records completed writes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

type Snapshot = { exists: boolean; contents?: string; mode?: number };

const input = JSON.parse(readFileSync(0, "utf8"));
const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
const sid = input.session_id;
const dir = join(process.env.HOME ?? "", ".claude", "turn-flags");

function snapshotPath(sessionId: string, filePath: string): string {
  return join(dir, `${sessionId}.snapshots`, createHash("sha256").update(filePath).digest("hex"));
}

if (typeof sid === "string" && sid.length > 0 && typeof path === "string" && path.length > 0) {
  mkdirSync(dir, { recursive: true });
  if (process.argv[2] === "--snapshot") {
    const destination = snapshotPath(sid, path);
    if (!existsSync(destination)) {
      mkdirSync(join(dir, `${sid}.snapshots`), { recursive: true });
      const snapshot: Snapshot = existsSync(path)
        ? { exists: true, contents: readFileSync(path).toString("base64"), mode: statSync(path).mode & 0o777 }
        : { exists: false };
      writeFileSync(destination, JSON.stringify(snapshot));
    }
  } else {
    appendFileSync(join(dir, sid), `${path}\n`);
  }
}
