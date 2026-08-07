// stagedDiffs.ts: prints staged diffs for the root repo and any submodule with a moved pointer, at any depth.
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const EXCLUDES = ["--", ":(exclude)*tasks.json", ":(exclude)*completedTasks.json", ":(exclude)plans/archived"];

function stagedDiff(repo: string): string {
  return execFileSync("git", ["-C", repo, "diff", "--staged", ...EXCLUDES], { encoding: "utf8" });
}

function movedSubmodulePaths(repo: string): string[] {
  const raw = execFileSync("git", ["-C", repo, "diff", "--staged", "--raw", "-z", ...EXCLUDES], { encoding: "utf8" });
  const fields = raw.split("\0").filter(Boolean);
  const paths = new Set<string>();
  let i = 0;
  while (i < fields.length) {
    const [, newMode, , , status] = fields[i].split(" ");
    const isRenameOrCopy = status?.[0] === "R" || status?.[0] === "C";
    const path = isRenameOrCopy ? fields[i + 2] : fields[i + 1];
    i += isRenameOrCopy ? 3 : 2;
    if (newMode === "160000" && path) paths.add(path);
  }
  return [...paths];
}

const root = execFileSync("git", ["-C", process.cwd(), "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const seen = new Set<string>([root]);
const queue = [root];

while (queue.length > 0) {
  const repo = queue.shift()!;
  let diff: string;
  try {
    diff = stagedDiff(repo);
  } catch {
    continue;
  }
  if (diff.trim().length > 0) {
    const label = repo === root ? basename(root) : repo.slice(root.length + 1);
    process.stdout.write(`=== ${label} ===\n${diff}\n`);
  }
  for (const path of movedSubmodulePaths(repo)) {
    const submodule = `${repo}/${path}`;
    if (seen.has(submodule)) continue;
    seen.add(submodule);
    queue.push(submodule);
  }
}
