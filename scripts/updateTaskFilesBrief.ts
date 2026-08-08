import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand
const getTaskDetailsPath = fileURLToPath(new URL("./getTaskDetails.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

export const updateTaskFilesBrief = (argsValue: string, taskDetails: string) => {
  const brief = `- repo root: ${repoRoot}
- task details: ${taskDetails}

First, invoke \`/ponytail:ponytail ultra\`.

Add a \`files\` array to each task shown above, inserted after \`description\`. If a task
already has one, verify it against the current codebase rather than rewriting it.

Invocation format: the first argument is a JSON array of task numbers with **no spaces** —
\`[332,335]\`. If no numbers were given, the block above lists every task; ask the user which
ones to backfill rather than rewriting all of them.

## Path rules

- Repo-relative to the repo root printed above — the directory holding \`tasks.json\`. Never
  absolute, never relative to a subdirectory.
- Files inside a git submodule are still written relative to that same root, so they carry
  the submodule directory as a prefix (for example \`jfred/tests/layer1-filenav.test.ts\`).
- Every path must already exist on disk. Verify each one. A path that does not resolve
  silently degrades the task's brief to \`(missing: file not found)\` at run time.
- Include implementation files and their test files.

## Why accuracy matters

This list is load-bearing, not documentation. Two mechanisms read it:

1. **Ownership fence.** The worker implementing the task is told "touch nothing outside
   them". Under-declaring blocks the worker from files it needs.
2. **Concurrency key.** Tasks sharing any path are sequenced together inside one git
   worktree; tasks with disjoint paths run in parallel in separate worktrees.
   Over-declaring serializes work that could have run concurrently. Under-declaring lets
   two workers edit the same file in different worktrees, which surfaces later as a merge
   conflict.

List what the task genuinely touches — not the whole module, and not one file when the
change spans three.

## When you cannot tell

If a task is too vague to determine its files, leave that task's \`files\` field out and
report its number. A wrong list is worse than no list: the task will simply be refused
again, which is the correct outcome for a task that needs rethinking rather than
annotating.

## Editing rules

- Edit \`tasks.json\` in place. Do **not** use the \`create-task\` skill — that skill appends
  new tasks, and this is a field backfill on existing ones. The rule against editing
  \`tasks.json\` directly governs *adding* tasks, which this skill does not do.
- Never touch \`completedTasks.json\`.
- Preserve every existing field, key order, task order, and task number. Do not reformat,
  reorder, renumber, or drop any entry.
- Change no source code.

## Verify before reporting

- The task count in \`tasks.json\` is unchanged.
- Every path you added exists: check each one on disk.
- \`git diff\` shows changes to \`tasks.json\` only.

## Report

A table of task number to files, then a separate list of the task numbers you left without
a \`files\` field, each with the reason it could not be determined.
`;
  return brief;
};

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Arguments arrive on stdin, so an empty read must stop here rather than emit a brief pointing nowhere.
function fail(problem: string): never {
  process.stderr.write(
    `updateTaskFilesBrief: ${problem}\n` +
      `usage: node updateTaskFilesBrief.ts <<'UPDATETASKFILESEOF'\n[N,N,...]\nUPDATETASKFILESEOF\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("updateTaskFilesBrief.ts")) {
  const argsValue = readStdin().replace(/\n$/, "");
  if (argsValue === "") fail("no arguments on stdin");
  const taskDetails = execFileSync("node", [getTaskDetailsPath, argsValue], { encoding: "utf8" }).trimEnd();
  process.stdout.write(updateTaskFilesBrief(argsValue, taskDetails));
}
