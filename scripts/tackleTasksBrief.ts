import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TASKS_PER_COMMAND } from "./taskStats.ts";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand
const checkBlockersPath = fileURLToPath(new URL("./checkBlockers.ts", import.meta.url));
const blockerVerdictsPath = fileURLToPath(new URL("./blockerVerdicts.ts", import.meta.url));
const getTaskDetailsPath = fileURLToPath(new URL("./getTaskDetails.ts", import.meta.url));
const prepareTasksPath = fileURLToPath(new URL("./prepareTasks.ts", import.meta.url));
const skillDir = new URL("../skills/tackle-tasks/", import.meta.url);
const blockersWorkflowPath = fileURLToPath(new URL("blockers.workflow.js", skillDir));
const taskWorkflowPath = fileURLToPath(new URL("task.workflow.js", skillDir));

// Opt-in, so a brief without `series` stays byte-identical to the parallel one.
const seriesSection = (argsValue: string) =>
  /\bseries\b/.test(argsValue)
    ? `
## Serial mode

\`series\` is in the arguments: treat the task numbers as a chain. Run everything below once per task number, in the order given, and finish one task completely — through **Closing your tasks** — before starting the next. Never prepare or plan two of them together.

The blocked status at the top of this brief was computed once, before any of these tasks closed, so it is stale for every task after the first. Ignore it and re-run \`node "${checkBlockersPath}" '[N]'\` for each task as you reach it. Re-run the \`${getTaskDetailsPath}\` and \`${prepareTasksPath}\` commands above the same way, with a single-element array \`'[N]'\`, so each task gets its own details and its own pipeline args.

If a task ends with anything unmerged, stop the chain and report. The next task's blocker is still open, and planning it against a base its predecessor never landed on wastes the run.

Do the **Commit message** section once, after the last task, not per task.
`
    : "";

export const tackleTasksBrief = (argsValue: string, blockedStatus: string) => {
  const brief = `- blocked status: ${blockedStatus}

Invocation format: the task numbers come first as a JSON array with **no spaces** — \`[268,270,281]\` — followed by \`valid\` and any free text. The scripts above read the whole argument string and stop at the first token that is not part of the array, so anything after it is ignored by them. Avoid apostrophes and backticks in that trailing text; it reaches the shell inside single quotes.

Every task reported BLOCKED above lists its open blocker(s) as a JSON array — investigate before trusting the report. Parse each BLOCKED line's JSON array into one \`{ blockedTask, blockerTask, reason }\` entry per element (\`blockedTask\` is the task number named in "task N: BLOCKED", \`blockerTask\` is that element's \`taskNum\`, \`reason\` is that element's \`reason\` taken verbatim). Call Workflow with scriptPath \`${blockersWorkflowPath}\`, args \`{ pairs }\` where \`pairs\` is the full list built this way across every BLOCKED task above. It returns \`{ disproven, stillBlocked }\`. For every entry in \`disproven\`, in order, run with Bash:

\`\`\`
node "${blockerVerdictsPath}" <blockedTask> <blockerTask> <<'BLOCKERREASONEOF'
<the entry's reason, verbatim>
BLOCKERREASONEOF
\`\`\`

The delimiter must stay single-quoted so the shell performs no expansion on the reason text. Do not work on any task with an entry left in \`stillBlocked\` — report those open blockers and move on to the next requested task that is unblocked. If nothing was reported BLOCKED, skip straight to the next paragraph.

Now get task details and the pipeline args yourself with Bash, in this order, so both run after any stripping above and see a disproven task as runnable, using only commands that start with \`node\` (the skill's \`allowed-tools\` permits \`Bash(node *)\`, not compound shell commands like \`u=$(...)\`): first run \`node "${checkBlockersPath}" --unblocked '${argsValue}'\` and read its output. If that output is non-empty, run \`node "${getTaskDetailsPath}" <output>\`, substituting the exact output text (the space-separated task numbers) in place of \`<output>\`. If that output is empty, skip that command and report "none of the requested tasks are unblocked" yourself instead. Then, regardless of the previous step, run \`node "${prepareTasksPath}" '${argsValue}'\`.

Invoke \`/ponytail:ponytail ultra\`.

When \`${argsValue}\` contains the word \`valid\`, the user has confirmed the tasks are still relevant — skip the **Verification** section below and treat every unblocked task in the details above as open and relevant.
${seriesSection(argsValue)}
## Verification

Review the task details above (each object comes from \`tasks.json\` if the task is open, or \`completedTasks.json\` if it was already completed). Cross-reference the task with the codebase to determine if the task is still relevant or if it has been resolved.
Use the git history and recent commits (over the last 3 days) to confirm/deny the existence of the unblocked tasks detailed above.

## Running the pipeline

The "pipeline args" JSON printed above has these keys: \`repo\`,
\`typecheckCommand\`, \`groups\`, \`repositorySources\`, \`repositoryManifest\`,
\`runId\`, \`startTimestamp\`, \`mergeScript\`. \`groups\` has one entry per task,
and each entry's task number is at \`tasks[0].number\`.

Launch \`${taskWorkflowPath}\` once per entry in \`groups\`, as a **background**
workflow — the call returns immediately, so the orchestrator stays free to
launch the next task's workflow right away.

Keep up to ${TASKS_PER_COMMAND} task.workflow.js runs in flight, and start
the next task as soon as any one of them finishes — a sliding window, not
batches of ${TASKS_PER_COMMAND} with a barrier between them. Fewer tasks
than ${TASKS_PER_COMMAND} means fewer runs; ${TASKS_PER_COMMAND} is a
ceiling, never a batch size to fill.

Args for each launch: \`{task, typecheckCommand}\`, where \`task\` is that
entry's \`tasks[0].number\` and \`typecheckCommand\` is the value from the
pipeline args above. For example, for the group whose \`tasks[0].number\` is
\`268\`:

\`\`\`json
{"task": 268, "typecheckCommand": "npx tsc --noEmit"}
\`\`\`

Pass nothing else. \`task.workflow.js\` reads only \`task\`, \`stage\`,
\`typecheckCommand\`, \`workerModel\`, and \`maxRounds\` from its args — it loads
everything else about the task (its brief, plan path, owned files) itself,
straight from tasks.json.

Each task workflow's completion sends a task-notification back to you. That
notification — not polling — is how you learn a task is ready.

## Gate each task

The moment a task's own task-notification says it finished plan+implement,
gate that task immediately, in this main conversation — never inside a
workflow or a subagent, since \`AskUserQuestion\` is stripped from every
subagent and is not a workflow-script hook. Do not wait for any other
task's workflow to finish; one task's gate never waits on another task's
notification.

Call \`AskUserQuestion\` once for that task. Include an explicit decision
for the task itself — "Approve for merge" or "Do not approve" — alongside
its status, the fence violations the implement stage recorded for it
(task 138), and the codex objections that survived that task's
plan-review rounds (task 135). Present each fence violation and each
surviving objection as its own proposed task, separate from the approval
decision, that the user can accept or reject. For every proposed task the
user accepts, invoke the \`create-task\` skill once, never edit
\`tasks.json\` directly. Drop every proposed task the user rejects without
recording it anywhere.

Only "Approve for merge" clears a task to merge; "Do not approve" means
the task never enters the merge queue and never merges. An approved task
enters the merge queue immediately on approval — even while other tasks
are still planning or implementing. Never hold an approved task back to
gate or merge it alongside the rest, and never let this gate become a
barrier that waits for the whole batch.

## Closing your tasks

Close every task that is not problematic and was completed successfully, rendering its \`tasks.json\` entry stale, with **one** invocation of the \`close-tasks\` skill for all of them. Its first argument must be a JSON array of the task numbers with no spaces — \`[268,270,281]\` — followed by your reasoning for the \`closureNote\`s, naming each task (\`#268 …, #270 …\`) when the reasons differ.

If the user requests adding tasks, invoke the \`create-task\` skill once per task — never edit \`tasks.json\` directly.

During implementation, you (the orchestrator) run typecheck only — no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + full suite + the repo's UI verification where relevant) still runs once inside \`close-tasks\`, after the user approves closing.

## Commit message

Finally, stage the changes made this session — which may span multiple git repos or submodules — in each affected repo, but do not commit in any of them. Then invoke the \`commit-message\` skill to generate a commit-message summary for each affected repo, and show the summaries to the user.
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
    `tackleTasksBrief: ${problem}\n` +
      `usage: node tackleTasksBrief.ts <<'TACKLETASKSEOF'\n[N,N,...] [valid]\nTACKLETASKSEOF\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("tackleTasksBrief.ts")) {
  const argsValue = readStdin().replace(/\n$/, "");
  if (argsValue === "") fail("no arguments on stdin");
  const blockedStatus = execFileSync("node", [checkBlockersPath, argsValue], { encoding: "utf8" }).trimEnd();
  process.stdout.write(tackleTasksBrief(argsValue, blockedStatus));
}
