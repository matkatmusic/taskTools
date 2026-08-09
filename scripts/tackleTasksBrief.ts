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
const runMergePhaseUrl = new URL("./runMergePhase.ts", import.meta.url).href;

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

## Merge queue

Entering the merge queue does not merge a task by itself — you drive the queue forward with a quoted heredoc passed to \`node --input-type=module\` that imports \`${JSON.stringify(runMergePhaseUrl)}\` and carries the printed queue JSON forward yourself, in this conversation, between commands; nothing persists it to disk. The heredoc's quoted delimiter (\`<<'TASK_TOOLS_QUEUE'\`) stops the shell from interpolating anything inside it, so the queue JSON and any string arguments pass through to Node untouched. Every command below has this exact shape, with \`FN\` and \`ARGS\` filled in per the table that follows it, and \`<QUEUE_JSON>\` replaced with the queue object's literal JSON text as printed by the most recent command that returned a queue (always inserted as the first argument when the table lists it):

\`\`\`
node --input-type=module <<'TASK_TOOLS_QUEUE'
const { FN } = await import(${JSON.stringify(runMergePhaseUrl)});
console.log(JSON.stringify(FN(ARGS)));
TASK_TOOLS_QUEUE
\`\`\`

- Start (once, before the first gate): \`FN\` = \`createMergeQueue\`, \`ARGS\` = (empty). Record the printed JSON as \`queue\`.
- On "Approve for merge": \`FN\` = \`enqueueApprovedTask\`, \`ARGS\` = \`<QUEUE_JSON>, taskNumber\`. Record the printed JSON as the new \`queue\`.
- Step: \`FN\` = \`nextQueueStep\`, \`ARGS\` = \`<QUEUE_JSON>\`.
- Outcome: \`FN\` = \`recordStageOutcome\`, \`ARGS\` = \`<QUEUE_JSON>, taskNumber, "stage", outcome\` (\`outcome\` is \`{"status":"success"}\` or \`{"status":"failure","reason":lastFailure}\`). Record the printed JSON as the new \`queue\`.
- Merged-not-closed: \`FN\` = \`recordMergedNotClosed\`, \`ARGS\` = \`<QUEUE_JSON>, taskNumber, mergedCommitHash, closeError\`. Record the printed JSON as the new \`queue\`.
- End check: \`FN\` = \`shouldEndQueue\`, \`ARGS\` = \`<QUEUE_JSON>, workflowOutstanding\`.
- Next lap: \`FN\` = \`beginNextLap\`, \`ARGS\` = \`<QUEUE_JSON>\`. Record the printed JSON as the new \`queue\`.
- Report: \`FN\` = \`buildMergeReport\`, \`ARGS\` = \`<QUEUE_JSON>\`.

Track \`outstandingEntries\`, a map from task number to \`"plan+implement"\`, \`"rebase-test"\`, or \`"merge"\`, naming the workflow you currently have launched for that task and awaiting a result on. Add an entry the moment you launch that task's \`plan+implement\` workflow (before this section — task planning and implementing happens outside the merge queue proper, but its notification still gates when the queue may end). Add an entry when you launch a \`rebase-test\` or \`merge\` workflow, per step 1 below. Remove a task's entry only in these two cases:
- Its \`plan+implement\` completion notification arrives: immediately ask that task's own approval gate (per "## Gate each task" above), before doing anything else in this section. On "Approve for merge", run \`enqueueApprovedTask(queue, taskNumber)\` and record the printed JSON as the new \`queue\`, then remove the entry. On "Do not approve", remove the entry without enqueueing.
- Its \`rebase-test\` or \`merge\` completion notification arrives and step 2 below has recorded the outcome: remove the entry.

\`workflowOutstanding\`, passed to \`shouldEndQueue\`, is \`outstandingEntries.size > 0\`. After every enqueue and every completion notification, repeat:

1. Run \`nextQueueStep(queue)\`. If it prints \`null\`, skip to step 3. If it prints a step \`{taskNumber, stage}\`: if any task's entry in \`outstandingEntries\` is \`"rebase-test"\` or \`"merge"\`, a rebase-test or merge workflow you launched is still outstanding — do not launch anything; wait for that workflow's completion notification, then go back to step 1. Otherwise, launch \`${taskWorkflowPath}\` as a background workflow with args \`{task: taskNumber, stage, repositoryManifest}\` — \`repositoryManifest\` is the pipeline args value from above — add \`taskNumber → stage\` to \`outstandingEntries\`, and go back to step 1. Merging stays serial: never launch a second rebase-test or merge workflow while one is still outstanding, because every merge moves the tip the next task rebases onto.
2. When a launched rebase-test or merge workflow's completion notification arrives, read its result's \`status\` (\`green\` is success for \`rebase-test\`; \`merged\` or \`merged-but-not-closed\` is success for \`merge\`; anything else is a failure, with \`lastFailure\` naming why). Run \`recordStageOutcome(queue, taskNumber, stage, outcome)\` — \`outcome\` is \`{"status":"success"}\` or \`{"status":"failure","reason":lastFailure}\` — and record the printed JSON as the new \`queue\`. If the merge stage reported \`merged-but-not-closed\`, also run \`recordMergedNotClosed(queue, taskNumber, mergedCommitHash, closeError)\` and record that printed JSON as the new \`queue\`. Remove that task's entry from \`outstandingEntries\`. Then go back to step 1.
3. Run \`shouldEndQueue(queue, workflowOutstanding)\`. If it prints \`true\`, the queue is done: run \`buildMergeReport(queue)\` and report its \`unmerged\` and \`mergedNotClosed\` entries to the user. If it prints \`false\` and \`queue\`'s \`carryover\` is non-empty, run \`beginNextLap(queue)\`, record the printed JSON as the new \`queue\`, and go back to step 1. If it prints \`false\` and \`carryover\` is empty, a task is still planning, implementing, or waiting on its own gate — wait for the next enqueue or completion notification, then go back to step 1.

## Closing your tasks

Closing each merged task happens automatically: \`${taskWorkflowPath}\`'s merge stage calls scripts/closeTasks.ts directly once that task's own merge has succeeded, hash-gated so a task is archived only against the commit it actually merged into. You never invoke a skill to close a task, and \`buildMergeReport\`'s \`mergedNotClosed\` entries name every task that merged but failed to archive, so you can follow up.

If the user requests adding tasks, invoke the \`create-task\` skill once per task — never edit \`tasks.json\` directly.

During implementation, you (the orchestrator) run typecheck only — no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + each layer's complete test suite) runs once per task, inside that task's own rebase-test stage, before it can reach the merge queue's merge stage.

## Commit message

Finally, stage the changes made this session — which may span multiple git repos or submodules — in each affected repo, but do not commit in any of them. Then invoke the \`commit-message\` skill to generate a commit-message summary for each affected repo, and show the summaries to the user.
`;
  return brief;
};

// RETIRED (task 157): old close-tasks-skill text superseded by task 152's closeTasks.ts call; see git history.

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
