import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listTaskTitles, readTaskLists } from "../shared/getTaskDetails.ts";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand
const getTaskDetailsPath = fileURLToPath(new URL("../shared/getTaskDetails.ts", import.meta.url));
const checkBlockersPath = fileURLToPath(new URL("../shared/checkBlockers.ts", import.meta.url));

export const pickATaskBrief = (argsValue: string, openTasks: string, blockedStatus: string) => `Number of tasks to pick: ${argsValue} (default 1 if blank or not a number).

Open tasks: ${openTasks}

Blocked status: ${blockedStatus}

Exclude any task reported as BLOCKED in the "Blocked status" above — it is not eligible regardless of difficulty.

For every remaining (non-blocked) open task number, pull its full record in one call — \`node "${getTaskDetailsPath}" <N...>\` with all the numbers passed at once — and read each record's \`difficulty\` field (1 = typo, comment, or constant edit with no behavior change; 2 = one-line or single-file mechanical change; 3 = one file edited alongside an existing test that already covers it; 4 = contained change to one file plus its test; 5 = a few files in one subsystem, mostly mechanical; 6 = several files in one subsystem, design already settled; 7 = one subsystem plus the callers it forces to change; 8 = crosses subsystems or needs design decisions during implementation; 9 = crosses subsystems with the design still unsettled; 10 = wide blast radius, unclear scope, or a previously reverted attempt).

Sort the remaining open tasks by difficulty ascending; break ties by task number ascending. This ordering replaces reasoning about scope; do not re-derive ease from reading the task body.

Starting from the lowest difficulty, for each candidate check the one thing difficulty can't tell you: is it still relevant given the current state of the code? Using the full record already pulled above, check the files listed in its \`files\` field — has this already been done, or does the premise no longer hold? Skip irrelevant candidates and continue down the sorted list.

Stop once you have N relevant tasks, or the sorted list is exhausted. Report to the user: each task's number, title, difficulty, and a one-line relevance note — under 15 words per task. Do not start implementing any of them.

If fewer than N tasks qualify, report the ones that do and add the line \`Only <count> eligible relevant task(s) found.\`, then end with the closing lines below using those task numbers. If no task qualifies, report \`No eligible relevant tasks found.\` and omit the closing lines — there are no task numbers to put in them.

Otherwise end your report with exactly:
\`start a session with: 'claude --name "task <N...>"'\`
\`prompt: "/tackle-tasks [<N,...>]"\`
where \`<N...>\` is the chosen task numbers space-separated, and \`[<N,...>]\` is the same numbers as a JSON array with no spaces (\`[268,270]\`) — the argument form tackle-tasks and close-tasks require.
`;

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// A task with an active run is already being worked; it is not a candidate.
function openTasksReport(): string {
  const { openTasks } = readTaskLists();
  const inactive = openTasks.filter((task) => !(task.run as { active?: boolean } | undefined)?.active);
  return listTaskTitles("OPEN", inactive).join("\n");
}
// grep exits non-zero when it matches nothing; that is not a failure here, just an empty result.
// function openTasksReport(): string {
//   try {
//     return execSync(`node "${getTaskDetailsPath}" | grep ^OPEN`, { encoding: "utf8" }).trimEnd();
//   } catch (error) {
//     const stdout = (error as { stdout?: string }).stdout;
//     return typeof stdout === "string" ? stdout.trimEnd() : "";
//   }
// }

// Arguments arrive on stdin; an empty read prints the usage as the skill's output instead of a brief.
function fail(problem: string): never {
  process.stdout.write(
    `pickATaskBrief: ${problem}\n` +
      `usage: node pickATaskBrief.ts <<'PICKATASKEOF'\n[N]\nPICKATASKEOF\n`,
  );
  process.exit(0);
}

if (process.argv[1]?.endsWith("pickATaskBrief.ts")) {
  const argsValue = readStdin().replace(/\n$/, "");
  if (argsValue === "") fail("no arguments on stdin");
  const openTasks = openTasksReport();
  const blockedStatus = execFileSync("node", [checkBlockersPath], { encoding: "utf8" }).trimEnd();
  process.stdout.write(pickATaskBrief(argsValue, openTasks, blockedStatus));
}
