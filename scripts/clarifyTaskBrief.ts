import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand
const getTaskDetailsPath = fileURLToPath(new URL("./getTaskDetails.ts", import.meta.url));
const clarifyTaskPath = fileURLToPath(new URL("./clarifyTask.ts", import.meta.url));

export const clarifyTaskBrief = (argsValue: string, taskDetails: string): string => {
  const brief = `- tasks to clarify: ${taskDetails}

\`${argsValue}\` holds the whole invocation: the task numbers first as a JSON array with **no spaces** — \`[94,95,96]\` — then optional free text the user added, which may already answer some questions.

Each task above carries a \`clarifyRequest\`: a question the planner asked because its brief did not give it enough to plan. Skip any task without one and say so.

For each task, answer the question from the code, not from the task text. Read the files the question names and the files the task owns; trace the live path (the code that runs today), and say plainly when something the question assumes does not exist, is dead code, or moved. Every claim in the answer names a file path and, where useful, a function name. If the answer is "wait for task N to land first", say which task and why. If the question names a file the task must read or edit, add it to the task's files. Use AskUserQuestion when the answer is a decision only the user can make.

Then record each answer with one call per task — this is the only permitted way to write it; never edit tasks.json yourself:

\`\`\`
node "${clarifyTaskPath}" <<'CLARIFYEOF'
{"taskNumber": N, "answer": "<the answer, markdown allowed>", "files": ["<extra repo-relative paths the answer names>"], "blockedBy": [{"taskNum": N, "reason": "<why>"}]}
CLARIFYEOF
\`\`\`

\`files\` and \`blockedBy\` are optional: omit \`files\` when the answer names nothing new, omit \`blockedBy\` to leave the task's blockers as they are. The script appends the answer to the task's \`description\` under a dated "Clarification answer" heading, widens \`files\`, sets \`blockedBy\`, removes \`clarifyRequest\`, clears every entry of \`run.history\`'s \`attempts\` and \`countedPasses\`, and deletes the worktree's \`plans/checkpoint.json\` so the next launch starts at the preamble with a fresh planner instead of replaying the old CLARIFY packet.

Stage .taskTools/tasks.json but do not commit. Provide a short commit message to the user, similar to "Answer clarify requests on tasks [94,95,96]", naming the numbers you actually answered.
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
    `clarifyTaskBrief: ${problem}\n` +
      `usage: node clarifyTaskBrief.ts <<'CLARIFYTASKEOF'\n[N,N,...] <optional answers>\nCLARIFYTASKEOF\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("clarifyTaskBrief.ts")) {
  const argsValue = readStdin().replace(/\n$/, "");
  if (argsValue === "") fail("no arguments on stdin");
  const taskDetails = execFileSync("node", [getTaskDetailsPath, argsValue], { encoding: "utf8" }).trimEnd();
  process.stdout.write(clarifyTaskBrief(argsValue, taskDetails));
}
