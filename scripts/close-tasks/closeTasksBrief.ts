import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand
const getTaskDetailsPath = fileURLToPath(new URL("../shared/getTaskDetails.ts", import.meta.url));
const closeTasksPath = fileURLToPath(new URL("./closeTasks.ts", import.meta.url));

export const closeTasksBrief = (argsValue: string, taskDetails: string): string => {
  const brief = `- tasks to close: ${taskDetails}

Invocation format: the task numbers come first as a JSON array with **no spaces** — \`[268,270,281]\` — and everything after them is free-text reasoning. The script reads the whole argument string and stops at the first token that is not part of the array, so the reasoning is ignored by it. Avoid apostrophes and backticks in that reasoning; it reaches the shell inside single quotes. If the details above don't cover every task number named in \`${argsValue}\` — a full listing instead, or only the first few — the invoker skipped the array form or put spaces in it: re-run the script yourself with all the numbers before continuing.

\`${argsValue}\` holds the whole invocation, reasoning included, and may attribute reasons per task (\`#268 fixed by X, #270 verified by user\`).

Before archiving anything, run the project's verification once for the whole batch: typecheck plus the full test suite, and the repo's stated UI/browser verification if any closing task touched UI. If failures trace to the work being closed, fix them, re-stage the fixes, and re-run until green — only then archive. This is a regression gate, not a re-litigation of doneness.

The decision that these tasks are done has already been made (by the user, or by the skill that invoked this one) — do not re-litigate it. Before closing, search git history for the commit(s) that resolved each task; use an empty array for a task only if none can be identified. Close every listed OPEN task in exactly one invocation of \`node "${closeTasksPath}" '[N,N,...]' '<note>' '<hashes>'\` — never split the batch across calls: the first argument is every listed task number as one no-space JSON array. The second argument is either one sentence of closure reasoning shared by every task number in that array, or — when tasks in the same call need different reasoning — a no-space JSON object mapping each task number to its own sentence, e.g. \`{"64":"fixed by abc123","65":"verified by user"}\`; use the invoker's reasoning for that specific task where they gave one, their general reasoning otherwise, and "closed manually by user" if they gave none. The third argument is optional and follows the same shared-vs-per-task shape for the commit hashes found above: a no-space JSON array shared by every task in the call, e.g. \`["abc123"]\`, or a no-space JSON object mapping each task number to its own array, e.g. \`{"64":["abc123"],"65":[]}\`; omit this argument (or pass \`[]\`) only when no task in the call has any commits to record. Use the shared string/array forms only when every task in the batch has identical reasoning and hashes; otherwise use the per-task JSON object forms. Either way it is one call. The script writes today's date as \`completionDate\` and the resolved \`closureNote\`/\`commitHashes\` onto each closed task's record, splices it out of \`tasks.json\`, appends it to \`completedTasks.json\`, and reports which numbers it closed, which it skipped (already COMPLETED or not found in either file), and which dependent tasks it removed from \`blockedBy\` as a result — relay the skipped and unblocked ones to the user.

Stage the changes but do not commit. Provide a short commit message to the user, similar to "Closed tasks [268,270,281]" or "Closed task [268]", naming the numbers you actually closed.

If a spec document references these task numbers, mark those items done in the spec.
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
    `closeTasksBrief: ${problem}\n` +
      `usage: node closeTasksBrief.ts <<'CLOSETASKSEOF'\n[N,N,...] <why they are done>\nCLOSETASKSEOF\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("closeTasksBrief.ts")) {
  const argsValue = readStdin().replace(/\n$/, "");
  if (argsValue === "") fail("no arguments on stdin");
  const taskDetails = execFileSync("node", [getTaskDetailsPath, argsValue], { encoding: "utf8" }).trimEnd();
  process.stdout.write(closeTasksBrief(argsValue, taskDetails));
}
