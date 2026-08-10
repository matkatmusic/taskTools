import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TASKS_PER_COMMAND } from "./taskStats.ts";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand.
export const WORKFLOW_PATH = fileURLToPath(new URL("../skills/tackle-tasks/tackle-tasks.workflow.js", import.meta.url));
export const AGENT_PROMPT_EMITTER_PATH = fileURLToPath(new URL("./tackle-tasks_AgentPromptEmitter.ts", import.meta.url));
const checkBlockersPath = fileURLToPath(new URL("./checkBlockers.ts", import.meta.url));
const blockerVerdictsPath = fileURLToPath(new URL("./blockerVerdicts.ts", import.meta.url));
const getTaskDetailsPath = fileURLToPath(new URL("./getTaskDetails.ts", import.meta.url));
const prepareTasksPath = fileURLToPath(new URL("./prepareTasks.ts", import.meta.url));
const skillDir = new URL("../skills/tackle-tasks/", import.meta.url);
const blockersWorkflowPath = fileURLToPath(new URL("blockers.workflow.js", skillDir));
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

// ponytail: unlike commit-message's skillBody(argsValue), this one also takes blockedStatus — checkBlockers output the main agent must parse for blocker-disproving, not workflow-hidden data.
export const skillBody = (argsValue: string, blockedStatus: string): string => {
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

Launch \`${WORKFLOW_PATH}\` once per entry in \`groups\`, as a **background**
workflow — the call returns immediately, so the orchestrator stays free to
launch the next task's workflow right away.

Keep up to ${TASKS_PER_COMMAND} tackle-tasks.workflow.js runs in flight, and start
the next task as soon as any one of them finishes — a sliding window, not
batches of ${TASKS_PER_COMMAND} with a barrier between them. Fewer tasks
than ${TASKS_PER_COMMAND} means fewer runs; ${TASKS_PER_COMMAND} is a
ceiling, never a batch size to fill.

Args for each launch: \`{task, typecheckCommand, worktree, sourceRoot, agentPromptEmitterPath}\`,
where \`task\` is that entry's \`tasks[0].number\`, \`typecheckCommand\` is
the value from the pipeline args above, \`worktree\` is that same entry's
\`worktree\`, \`sourceRoot\` is the top-level pipeline args \`repo\` value —
the authoritative checkout that owns \`.taskTools/tasks.json\`, never the
task worktree — and \`agentPromptEmitterPath\` is always exactly
\`${JSON.stringify(AGENT_PROMPT_EMITTER_PATH)}\`. For example, for the group
whose \`tasks[0].number\` is \`268\` and whose \`worktree\` is
\`/tmp/taskTools-wt/repo/task-268\`:

\`\`\`json
{"task": 268, "typecheckCommand": "npx tsc --noEmit", "worktree": "/tmp/taskTools-wt/repo/task-268", "sourceRoot": "/path/to/repo", "agentPromptEmitterPath": ${JSON.stringify(AGENT_PROMPT_EMITTER_PATH)}}
\`\`\`

Pass nothing else. \`tackle-tasks.workflow.js\` reads only \`task\`, \`stage\`,
\`typecheckCommand\`, \`worktree\`, \`sourceRoot\`, \`agentPromptEmitterPath\`,
\`workerModel\`, and \`maxRounds\` from its args — it never imports or runs a
command itself; every git/fs/task-state operation runs through the agent
prompt emitter at that path. It loads everything else about the task (its
brief, plan path, owned files) itself, via the emitter, straight from the
worktree's own checkout of tasks.json.

Each task workflow's completion sends a task-notification back to you. That
notification — not polling — is how you learn a task is ready.

## Task workflow results

Every tackle-tasks.workflow.js run returns \`{task, stage, results}\`, where
\`results\` is an array of per-step results for that run's \`stage\`:

- \`rebase-test\`: \`results\` has one entry, the rebase-test result —
  \`{status, lastFailure, fenceViolations, ...}\`. \`status\` is
  \`"green"\` on success; anything else is a failure, with \`lastFailure\`
  naming why.
- \`merge\`: \`results\` has one entry, the merge result —
  \`{status, mergedCommitHash, closeError, ...}\`. \`status\` is
  \`"merged"\` or \`"merged-but-not-closed"\` on success; anything else is
  a failure.
- \`plan+implement\`: the first entry is the plan result —
  \`{status, verify, reviewRounds, ...}\`. When its \`status\` is
  \`"planned"\`, its \`verify\` is the verifier result
  \`{verdict, notes, reviewer, missingFiles}\`, and a second entry is the
  implement result \`{status, summary, remaining, notesFile,
  fenceViolations}\`. When the plan result's \`status\` is not \`"planned"\`,
  there is no second entry.

Never index \`results[]\` or reconstruct a stage outcome yourself. When a
task workflow completion notification arrives, pass its complete
\`{task, stage, results}\` JSON and the current \`queue\` to
\`consumeTaskWorkflowResult\` (see the function table below). For a
\`plan+implement\` notification, this returns \`{kind: "approval", queue,
approval}\`; \`approval\` — \`{taskNumber, status, verifier,
fenceViolations}\` — is what the gate below reads. For a \`rebase-test\` or
\`merge\` notification, it returns \`{kind: "queue", queue, taskNumber,
stage, status}\`; replace \`queue\` with the returned \`queue\` either way.

## Gate each task

The moment a task's own task-notification says it finished plan+implement,
run \`consumeTaskWorkflowResult(queue, envelope)\` on that notification (see
the function table below), then gate that task immediately, in this main
conversation — never inside a workflow or a subagent, since
\`AskUserQuestion\` is stripped from every subagent and is not a
workflow-script hook. Do not wait for any other task's workflow to finish;
one task's gate never waits on another task's notification.

Call \`AskUserQuestion\` once for that task. Include an explicit decision
for the task itself — "Approve for merge" or "Do not approve" — alongside
\`consumed.approval.status\`, the fence violations the implement stage recorded for it
(task 138), read from \`consumed.approval.fenceViolations\`, and the codex
objections that survived that task's
plan-review rounds (task 135), read from \`consumed.approval.verifier?.notes\`.
Present each fence violation and each
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
- Action: \`FN\` = \`nextQueueAction\`, \`ARGS\` = \`<QUEUE_JSON>, outstanding\` (\`outstanding\` is \`{any: outstandingEntries.size > 0, tail: [...outstandingEntries.values()].some(stage => stage === "rebase-test" || stage === "merge")}\`, literal JSON). Record the printed JSON as \`action\`.
- Consume: \`FN\` = \`consumeTaskWorkflowResult\`, \`ARGS\` = \`<QUEUE_JSON>, envelope\` (\`envelope\` is the workflow's complete \`{task, stage, results}\` result, literal JSON). Record the printed JSON as \`consumed\`; \`consumed.queue\` is the new \`queue\`. Never index \`results[]\` or call \`recordStageOutcome\`/\`recordMergedNotClosed\` directly — \`consumeTaskWorkflowResult\` does that internally.
- Next lap: \`FN\` = \`beginNextLap\`, \`ARGS\` = \`<QUEUE_JSON>\`. Record the printed JSON as the new \`queue\`.
- Report: \`FN\` = \`buildMergeReport\`, \`ARGS\` = \`<QUEUE_JSON>\`.

Track \`outstandingEntries\`, a map from task number to \`"plan+implement"\`, \`"rebase-test"\`, or \`"merge"\`, naming the workflow you currently have launched for that task and awaiting a result on. Add an entry the moment you launch that task's \`plan+implement\` workflow (before this section — task planning and implementing happens outside the merge queue proper, but its notification still gates when the queue may end). Add an entry when you launch a \`rebase-test\` or \`merge\` workflow, per the "launch" action below. Remove a task's entry only in these two cases:
- Its \`plan+implement\` completion notification arrives: immediately ask that task's own approval gate (per "## Gate each task" above), before doing anything else in this section. On "Approve for merge", run \`enqueueApprovedTask(queue, taskNumber)\` and record the printed JSON as the new \`queue\`, then remove the entry. On "Do not approve", remove the entry without enqueueing.
- Its \`rebase-test\` or \`merge\` completion notification arrives and the "consume" step below has recorded the outcome: remove the entry.

After every enqueue and every completion notification, compute \`outstanding\` (above) and run \`nextQueueAction(queue, outstanding)\` (the "Action" row). \`nextQueueAction\` is the single source of truth for whether to launch, wait, roll the lap, or stop — never derive that decision from \`pending\`, \`carryover\`, or \`outstandingEntries\` in prose. Handle the printed \`action\` by its \`kind\` and repeat until you hit \`"report"\`:

- \`"launch"\`: \`action.step\` is \`{taskNumber, stage}\`. Launch \`${WORKFLOW_PATH}\` as a background workflow with args \`{task: taskNumber, stage, typecheckCommand, repositoryManifest, worktree, sourceRoot, agentPromptEmitterPath}\` — \`typecheckCommand\` is the pipeline args value from above (the same value passed to the very first launch), \`repositoryManifest\` is the pipeline args value from above, \`worktree\` is the \`worktree\` field of the \`groups\` entry whose \`tasks[0].number\` equals \`taskNumber\`, \`sourceRoot\` is the top-level pipeline args \`repo\` value (the same value passed to the very first launch), and \`agentPromptEmitterPath\` is always exactly \`${JSON.stringify(AGENT_PROMPT_EMITTER_PATH)}\` — add \`taskNumber → stage\` to \`outstandingEntries\`, then recompute \`outstanding\` and run \`nextQueueAction\` again.
- \`"wait"\`: a rebase-test or merge workflow is still outstanding, or nothing is ready to launch and the lap can't roll yet. Wait for the next enqueue or completion notification, then recompute \`outstanding\` and run \`nextQueueAction\` again.
- \`"begin-next-lap"\`: run \`beginNextLap(queue)\`, record the printed JSON as the new \`queue\`, then recompute \`outstanding\` and run \`nextQueueAction\` again.
- \`"report"\`: no pending or retryable work remains (\`action.endState\` is \`"done"\` or \`"stuck"\`). Run \`buildMergeReport(queue)\` and report its \`unmerged\` and \`mergedNotClosed\` entries to the user. Stop driving the queue.

When a launched rebase-test or merge workflow's completion notification arrives, its result is the complete \`{task, stage, results}\` envelope. Run \`consumeTaskWorkflowResult(queue, envelope)\` (the "Consume" row above) and replace \`queue\` with the returned \`consumed.queue\`. \`consumed.status\` is \`"green"\` on success for \`rebase-test\`, or \`"merged"\`/\`"merged-but-not-closed"\` on success for \`merge\`; anything else is a failure. Never index \`results[]\` yourself. Remove that task's entry from \`outstandingEntries\`, then recompute \`outstanding\` and run \`nextQueueAction\` again. Merging stays serial: \`nextQueueAction\`'s \`tail\` check refuses to launch a second rebase-test or merge workflow while one is still outstanding, because every merge moves the tip the next task rebases onto.

## Closing your tasks

Closing each merged task happens automatically: \`${WORKFLOW_PATH}\`'s merge stage, via the agent prompt emitter's \`merge\` role, calls scripts/closeTasks.ts once that task's own merge has succeeded, hash-gated so a task is archived only against the commit it actually merged into. You never invoke a skill to close a task, and \`buildMergeReport\`'s \`mergedNotClosed\` entries name every task that merged but failed to archive, so you can follow up.

If the user requests adding tasks, invoke the \`create-task\` skill once per task — never edit \`tasks.json\` directly.

During implementation, you (the orchestrator) run typecheck only — no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + each layer's complete test suite) runs once per task, inside that task's own rebase-test stage, before it can reach the merge queue's merge stage.

## Commit message

Finally, stage the changes made this session — which may span multiple git repos or submodules — in each affected repo, but do not commit in any of them. Then invoke the \`commit-message\` skill to generate a commit-message summary for each affected repo, and show the summaries to the user.
`;
  return brief;
};

// RETIRED (task 163): old close-tasks-skill text superseded by task 152's closeTasks.ts call; see git history.
//
// Closed every non-problematic completed task with one \`close-tasks\` skill call; array of task numbers plus closureNote reasoning.
//
// Orchestrator ran typecheck only; workers ran their own tests. Full verification ran once inside \`close-tasks\`, after user approval.

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
    `tackle-tasks_SkillBodyEmitter: ${problem}\n` +
      `usage: node tackle-tasks_SkillBodyEmitter.ts <<'TACKLETASKSEOF'\n[N,N,...] [valid]\nTACKLETASKSEOF\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("tackle-tasks_SkillBodyEmitter.ts")) {
  const argsValue = readStdin().replace(/\n$/, "");
  if (argsValue === "") fail("no arguments on stdin");
  const blockedStatus = execFileSync("node", [checkBlockersPath, argsValue], { encoding: "utf8" }).trimEnd();
  process.stdout.write(skillBody(argsValue, blockedStatus));
}
