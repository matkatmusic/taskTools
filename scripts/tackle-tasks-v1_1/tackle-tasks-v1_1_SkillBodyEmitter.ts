import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand.
export const AGENT_PROMPT_EMITTER_PATH = fileURLToPath(new URL("./tackle-tasks-v1_1_AgentPromptEmitter.ts", import.meta.url));
const bootstrapWorkflowPath = fileURLToPath(new URL("../../skills/tackle-tasks-v1_1/bootstrap.workflow.js", import.meta.url));
const bootstrapAgentPromptEmitterPath = fileURLToPath(new URL("./tackle-tasks-v1_1_BootstrapAgentPromptEmitter.ts", import.meta.url));
const blockerVerdictsPath = fileURLToPath(new URL("../shared/blockerVerdicts.ts", import.meta.url));
const skillDir = new URL("../../skills/tackle-tasks-v1_1/", import.meta.url);
const blockersWorkflowPath = fileURLToPath(new URL("blockers.workflow.js", skillDir));
const runMergePhaseUrl = new URL("../shared/runMergePhase.ts", import.meta.url).href;

const bootstrapCall = (mode: "discover" | "prepare", argsValue: string) =>
  `{"scriptPath": ${JSON.stringify(bootstrapWorkflowPath)}, "args": {"mode": "${mode}", "argsValue": ${JSON.stringify(argsValue)}, "bootstrapAgentPromptEmitterPath": ${JSON.stringify(bootstrapAgentPromptEmitterPath)}}}`;

const isSeriesArgs = (argsValue: string): boolean => /\bseries\b/.test(argsValue);

// Shared by both modes: works unchanged whether one task or several are in scope.
const pipelineAndGateSections = `## Running the pipeline

\`pipelineArgs\` has these keys: \`repo\`,
\`typecheckCommand\`, \`groups\`, \`repositorySources\`, \`repositoryManifest\`,
\`runId\`, \`startTimestamp\`, \`mergeScript\`. \`groups\` has one entry per task,
and each entry's task number is at \`tasks[0].number\`.

Before launching anything: run \`FN\` = \`createMergeQueue\`, \`ARGS\` = (empty)
(the "Start" row in **Merge queue** below) and record the printed JSON as
\`queue\`. Track \`remainingPlanTasks\`, the list of every \`tasks[0].number\`
in \`pipelineArgs.groups\` in the order given — every task that still needs
its plan+implement launch. Track \`outstandingEntries\`, a map from task
number to \`"plan+implement"\`, \`"rebase-test"\`, or \`"merge"\`, naming the
workflow you currently have launched for that task and awaiting a result on.

\`maxConcurrency\` is one shared ceiling across every launch kind —
plan/implement, rebase-test, and merge — never a per-kind budget and never a
batch size to fill. \`nextSchedulerAction\` (see **Merge queue**'s table) is
the single capacity-aware decision point for all of them: compute \`ready\`
= \`{nextPlanTask: remainingPlanTasks[0] ?? null}\` and \`outstanding\` =
\`{any: outstandingEntries.size > 0, tail: [...outstandingEntries.values()].some(stage => stage === "rebase-test" || stage === "merge"), total: outstandingEntries.size, capacity: maxConcurrency}\`,
then run \`FN\` = \`nextSchedulerAction\`, \`ARGS\` = \`<QUEUE_JSON>, ready, outstanding\`.
Never launch anything outside this call, and never derive a launch decision
from \`remainingPlanTasks\`, \`pending\`, \`carryover\`, or \`outstandingEntries\`
in prose. Handle the printed \`action\` by its \`kind\` and repeat until you
hit \`"report"\`:

- \`"launch-plan"\`: \`action.taskNumber\` names the task. Launch that task's
  \`v1_1WorkflowPath\` as a **background** workflow — the call returns immediately, so the
  orchestrator stays free to launch the next thing right away — with args
  \`{task: action.taskNumber, typecheckCommand: pipelineArgs.typecheckCommand, repositoryManifest: pipelineArgs.repositoryManifest, worktree, sourceRoot: pipelineArgs.repo, runId: pipelineArgs.runId, agentPromptEmitterPath}\`
  (\`v1_1WorkflowPath\` and \`worktree\` are the fields of that name on the
  \`pipelineArgs.groups\` entry whose \`tasks[0].number\` equals
  \`action.taskNumber\`, and \`agentPromptEmitterPath\` is always exactly
  \`${JSON.stringify(AGENT_PROMPT_EMITTER_PATH)}\`). Remove \`action.taskNumber\`
  from \`remainingPlanTasks\`, add \`taskNumber → "plan+implement"\` to
  \`outstandingEntries\`, then recompute \`ready\`/\`outstanding\` and run
  \`nextSchedulerAction\` again.
- \`"launch-tail"\`: \`action.step\` is \`{taskNumber, stage}\`. Launch that
  task's \`v1_1WorkflowPath\` as a background workflow with args
  \`{task: taskNumber, stage, typecheckCommand: pipelineArgs.typecheckCommand, repositoryManifest: pipelineArgs.repositoryManifest, worktree, sourceRoot: pipelineArgs.repo, runId: pipelineArgs.runId, agentPromptEmitterPath}\`
  (\`v1_1WorkflowPath\` and \`worktree\` are the fields of that name on the
  \`pipelineArgs.groups\` entry whose \`tasks[0].number\` equals \`taskNumber\`,
  and \`agentPromptEmitterPath\` is always exactly \`${JSON.stringify(AGENT_PROMPT_EMITTER_PATH)}\`). Add
  \`taskNumber → stage\` to \`outstandingEntries\`, then recompute
  \`ready\`/\`outstanding\` and run \`nextSchedulerAction\` again.
- \`"wait"\`: nothing may launch this call — capacity is full, the ready
  tail is serialized behind one already outstanding, or nothing is ready
  and the lap can't roll yet. Wait for the next completion notification or
  gate decision, then recompute \`ready\`/\`outstanding\` and run
  \`nextSchedulerAction\` again.
- \`"begin-next-lap"\`: run \`beginNextLap(queue)\`, record the printed JSON
  as the new \`queue\`, then recompute \`ready\`/\`outstanding\` and run
  \`nextSchedulerAction\` again.
- \`"report"\`: no pending, retryable, or unlaunched work remains
  (\`action.endState\` is \`"done"\` or \`"stuck"\`). Run \`buildMergeReport(queue)\`
  — see **Closing your tasks** for what to do with its result — and stop
  driving the queue.

For example, a \`"launch-tail"\` for the group whose \`tasks[0].number\` is
\`268\`, whose \`worktree\` is \`/tmp/taskTools-wt/repo/task-268\`, and whose
\`v1_1WorkflowPath\` is \`/tmp/taskTools-wt/repo/task-268.tackle-tasks-v1_1.workflow.js\` — launch
that \`v1_1WorkflowPath\` with these args:

\`\`\`json
{"task": 268, "stage": "rebase-test", "typecheckCommand": "npx tsc --noEmit", "repositoryManifest": {}, "worktree": "/tmp/taskTools-wt/repo/task-268", "sourceRoot": "/path/to/repo", "runId": "abc123", "agentPromptEmitterPath": ${JSON.stringify(AGENT_PROMPT_EMITTER_PATH)}}
\`\`\`

Pass nothing else. \`tackle-tasks.workflow.js\` reads only \`task\`, \`stage\`,
\`typecheckCommand\`, \`worktree\`, \`sourceRoot\`, \`repositoryManifest\`,
\`runId\`, \`agentPromptEmitterPath\`, \`workerModel\`, and \`maxRounds\` from its
args — it never imports or runs a command itself; every git/fs/task-state
operation runs through the agent prompt emitter at that path. It loads
everything else about the task (its brief, plan path, owned files) itself,
via the emitter, straight from the worktree's own checkout of tasks.json.
\`runId\` matters beyond logging: the merge and cleanup-only roles use it to
verify they own the task's worktree lease before releasing it, so it must be
exactly \`pipelineArgs.runId\` on every launch, never omitted or invented.

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
  \`{status, mergedCommitHash, closeError, cleanupWarning, retainedArtifacts, ...}\`.
  \`status\` is \`"merged"\`, \`"merged-but-not-closed"\`, or
  \`"cleanup-incomplete"\` on success (the task merged either way; only
  \`"cleanup-incomplete"\` still leaves worktree/branch/persistence cleanup
  to retry — see **Closing your tasks**); anything else is a failure.
- \`cleanup-only\`: \`results\` has one entry — \`{status, cleanupWarning, retainedArtifacts}\`.
  \`status\` is \`"cleaned"\` on success; \`"cleanup-incomplete"\` means the
  retry itself needs retrying. Never a failure in the rebase-test/merge
  sense — this stage never re-merges or re-closes, so there is nothing to roll back.
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
\`merge\` notification, it usually returns \`{kind: "queue", queue,
taskNumber, stage, status}\`; replace \`queue\` with the returned \`queue\`
either way. A green \`rebase-test\` that also committed edits outside the
task's approved fence instead returns \`{kind: "requires-regate", queue,
approval: {taskNumber, fenceViolations}}\` — see **Gate each task** for how
to handle it. Never let that task's stage advance to merge without it.

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

When a \`rebase-test\` notification's \`consumeTaskWorkflowResult\` call
returns \`{kind: "requires-regate", queue, approval}\`, that task already
committed edits outside its originally approved fence while resolving a
rebase conflict — replace \`queue\` with the returned \`queue\`, then call
\`AskUserQuestion\` once more for that task, showing
\`approval.fenceViolations\` and asking the same "Approve for merge" /
"Do not approve" question. On approval, run \`FN\` =
\`approveRegatedTask\`, \`ARGS\` = \`<QUEUE_JSON>, taskNumber\` (see
**Merge queue**) and the task proceeds straight to the merge stage. On
rejection, run \`FN\` = \`rejectRegatedTask\`, \`ARGS\` =
\`<QUEUE_JSON>, taskNumber, reason\` — the task never merges; a retry is
not offered, since the cross-layer edit is already committed in branch
history.

## Merge queue

Entering the merge queue does not merge a task by itself — you drive the queue forward with a quoted heredoc passed to \`node --input-type=module\` that imports \`${JSON.stringify(runMergePhaseUrl)}\` and carries the printed queue JSON forward yourself, in this conversation, between commands; nothing persists it to disk. The heredoc's quoted delimiter (\`<<'TASK_TOOLS_QUEUE'\`) stops the shell from interpolating anything inside it, so the queue JSON and any string arguments pass through to Node untouched. Every command below has this exact shape, with \`FN\` and \`ARGS\` filled in per the table that follows it, and \`<QUEUE_JSON>\` replaced with the queue object's literal JSON text as printed by the most recent command that returned a queue (always inserted as the first argument when the table lists it):

\`\`\`
node --input-type=module <<'TASK_TOOLS_QUEUE'
const { FN } = await import(${JSON.stringify(runMergePhaseUrl)});
console.log(JSON.stringify(FN(ARGS)));
TASK_TOOLS_QUEUE
\`\`\`

- Start (once, before the first plan/implement launch — see **Running the pipeline**): \`FN\` = \`createMergeQueue\`, \`ARGS\` = (empty). Record the printed JSON as \`queue\`.
- On "Approve for merge": \`FN\` = \`enqueueApprovedTask\`, \`ARGS\` = \`<QUEUE_JSON>, taskNumber\`. Record the printed JSON as the new \`queue\`.
- Action: \`FN\` = \`nextSchedulerAction\`, \`ARGS\` = \`<QUEUE_JSON>, ready, outstanding\` (\`ready\` and \`outstanding\` are computed as described in **Running the pipeline**, literal JSON for both). Record the printed JSON as \`action\`.
- Consume: \`FN\` = \`consumeTaskWorkflowResult\`, \`ARGS\` = \`<QUEUE_JSON>, envelope\` (\`envelope\` is the workflow's complete \`{task, stage, results}\` result, literal JSON). Record the printed JSON as \`consumed\`; \`consumed.queue\` is the new \`queue\`. Never index \`results[]\` or call \`recordStageOutcome\`/\`recordMergedNotClosed\` directly — \`consumeTaskWorkflowResult\` does that internally.
- Regate approved (see **Gate each task**): \`FN\` = \`approveRegatedTask\`, \`ARGS\` = \`<QUEUE_JSON>, taskNumber\`. Record the printed JSON as the new \`queue\`.
- Regate rejected (see **Gate each task**): \`FN\` = \`rejectRegatedTask\`, \`ARGS\` = \`<QUEUE_JSON>, taskNumber, reason\`. Record the printed JSON as the new \`queue\`.
- Next lap: \`FN\` = \`beginNextLap\`, \`ARGS\` = \`<QUEUE_JSON>\`. Record the printed JSON as the new \`queue\`.
- Report: \`FN\` = \`buildMergeReport\`, \`ARGS\` = \`<QUEUE_JSON>\`.
- Cleanup retry (see **Closing your tasks**): \`FN\` = \`consumeCleanupRetryResult\`, \`ARGS\` = \`<QUEUE_JSON>, envelope\` (\`envelope\` is the \`cleanup-only\` workflow's complete \`{task, stage, results}\` result). Record the printed JSON as the new \`queue\`.

Remove a task's \`outstandingEntries\` entry only in these two cases:
- Its \`plan+implement\` completion notification arrives: immediately ask that task's own approval gate (per **Gate each task** above), before doing anything else here. On "Approve for merge", run \`enqueueApprovedTask(queue, taskNumber)\` and record the printed JSON as the new \`queue\`, then remove the entry. On "Do not approve", remove the entry without enqueueing.
- Its \`rebase-test\` or \`merge\` completion notification arrives: if "Consume" returned \`kind: "requires-regate"\`, gate it per **Gate each task** first, then remove the entry once approved or rejected. Otherwise remove the entry once "Consume" has recorded the outcome.

After every enqueue and every completion notification, recompute \`ready\`/\`outstanding\` and run \`nextSchedulerAction\` again, handling its result exactly as described in **Running the pipeline** — that section owns every \`action.kind\` (\`"launch-plan"\`, \`"launch-tail"\`, \`"wait"\`, \`"begin-next-lap"\`, \`"report"\`); never derive a launch, wait, or lap-roll decision from \`pending\`, \`carryover\`, or \`outstandingEntries\` in prose here instead.

When a launched rebase-test or merge workflow's completion notification arrives, its result is the complete \`{task, stage, results}\` envelope. Run \`consumeTaskWorkflowResult(queue, envelope)\` (the "Consume" row) and replace \`queue\` with the returned \`consumed.queue\`. \`consumed.status\` is \`"green"\` on success for \`rebase-test\`, or \`"merged"\`/\`"merged-but-not-closed"\`/\`"cleanup-incomplete"\` on success for \`merge\`; anything else is a failure. Never index \`results[]\` yourself. Remove that task's entry from \`outstandingEntries\`, then recompute \`ready\`/\`outstanding\` and run \`nextSchedulerAction\` again. Merging stays serial: a tail already outstanding is never launched a second time, because every merge moves the tip the next task rebases onto.

## Closing your tasks

Closing each merged task happens automatically: the task workflow's merge stage, via the agent prompt emitter's \`merge\` role, calls scripts/close-tasks/closeTasks.ts once that task's own merge has succeeded, hash-gated so a task is archived only against the commit it actually merged into. You never invoke a skill to close a task, and \`buildMergeReport\`'s \`mergedNotClosed\` entries name every task that merged but failed to archive, so you can follow up. \`buildMergeReport\`'s \`regateRejected\` entries name every task whose post-approval fence violation was rejected at the regate gate — report these to the user too; they never merged.

\`buildMergeReport\`'s \`cleanupIncomplete\` entries name every task whose merge (and close) succeeded but whose final worktree/branch/persistence cleanup did not — each is \`{taskNumber, warning, retainedArtifacts}\`. Report these to the user alongside \`unmerged\` and \`mergedNotClosed\`. Once whatever blocked cleanup (for example a locked worktree) is resolved, retry it: launch that task's \`v1_1WorkflowPath\` once as a background workflow with args \`{task: taskNumber, stage: "cleanup-only", repositoryManifest: pipelineArgs.repositoryManifest, worktree, sourceRoot: pipelineArgs.repo, runId: pipelineArgs.runId, agentPromptEmitterPath}\` (\`v1_1WorkflowPath\` and \`worktree\` are that task's \`pipelineArgs.groups\` entry's fields of the same name) — it only retries cleanup, it never re-merges or re-closes the task. On its completion notification, run \`consumeCleanupRetryResult(queue, envelope)\` (the "Cleanup retry" row), replace \`queue\` with the result, and re-run \`buildMergeReport(queue)\`; a successful retry clears that task from \`cleanupIncomplete\`. It is safe to invoke again if it reports \`"cleanup-incomplete"\` a second time.

If the user requests adding tasks, invoke the \`create-task\` skill once per task — never edit \`tasks.json\` directly.

During implementation, you (the orchestrator) run typecheck only — no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + each layer's complete test suite) runs once per task, inside that task's own rebase-test stage, before it can reach the merge queue's merge stage.
`;

const commitMessageSection = `## Commit message

Finally, stage the changes made this session — which may span multiple git repos or submodules — in each affected repo, but do not commit in any of them. Then invoke the \`commit-message\` skill to generate a commit-message summary for each affected repo, and show the summaries to the user.
`;

export const skillBody = (argsValue: string): string =>
  isSeriesArgs(argsValue) ? seriesSkillBody(argsValue) : parallelSkillBody(argsValue);

const parallelSkillBody = (argsValue: string): string => {
  const brief = `Run \`Workflow(${bootstrapCall("discover", argsValue)})\`. It returns \`{blockerPairs, unblockedNumbers}\` — the blocker check for every task number you were given, computed in an isolated agent so the raw task list never enters this conversation.

Invocation format: the task numbers come first as a JSON array with **no spaces** — \`[268,270,281]\` — followed by \`valid\` and any free text. Avoid apostrophes and backticks in that trailing text; it reaches a later shell command inside single quotes.

If \`blockerPairs\` is non-empty, call \`Workflow\` with scriptPath \`${blockersWorkflowPath}\`, args \`{ pairs: blockerPairs }\`. It returns \`{ disproven, stillBlocked }\`. For every entry in \`disproven\`, in order, run with Bash:

\`\`\`
node "${blockerVerdictsPath}" <blockedTask> <blockerTask> <<'BLOCKERREASONEOF'
<the entry's reason, verbatim>
BLOCKERREASONEOF
\`\`\`

The delimiter must stay single-quoted so the shell performs no expansion on the reason text. Do not work on any task with an entry left in \`stillBlocked\` — report those open blockers and move on to the next requested task that is unblocked. If \`blockerPairs\` was empty, skip straight to the next paragraph.

Now run \`Workflow(${bootstrapCall("prepare", argsValue)})\`, after any \`disproven\` stripping above so it sees a disproven task as runnable. It returns \`{taskDetails, pipelineArgs, maxConcurrency}\`: \`taskDetails\` is one \`{number, status, task}\` entry per unblocked task number (\`status\` is \`"open"\`, \`"completed"\`, or \`"not-found"\`, and \`task\` is that task's record from \`tasks.json\` or \`completedTasks.json\`, or \`null\`); \`pipelineArgs\` is the pipeline arguments described below; \`maxConcurrency\` is the concurrency ceiling for **Running the pipeline**.

Invoke \`/ponytail:ponytail ultra\`.

When \`${argsValue}\` contains the word \`valid\`, the user has confirmed the tasks are still relevant — skip the **Verification** section below and treat every entry in \`taskDetails\` as open and relevant.

## Verification

Review \`taskDetails\` from the prepare result above (each entry's \`task\` comes from \`tasks.json\` if \`status\` is \`"open"\`, or \`completedTasks.json\` if \`"completed"\`). Cross-reference the task with the codebase to determine if the task is still relevant or if it has been resolved.
Use the git history and recent commits (over the last 3 days) to confirm/deny the existence of the unblocked tasks in \`taskDetails\`.

${pipelineAndGateSections}
${commitMessageSection}`;
  return brief;
};

// No whole-array discover/prepare ever runs, so only one worktree lease is live at a time (C86-43).
const seriesSkillBody = (argsValue: string): string => {
  const brief = `\`series\` is in the arguments: treat the task numbers as a chain. For each task number, in the order given, run everything below once — through **Closing your tasks** — and finish that task completely before starting the next. Never discover, prepare, plan, or implement two of them together.

Invocation format: the task numbers come first as a JSON array with **no spaces** — \`[268,270,281]\` — followed by \`series\`, \`valid\`, and any free text. Avoid apostrophes and backticks in that trailing text; it reaches a later shell command inside single quotes.

For the current task number \`N\` in the chain, replace every \`argsValue\` reference below with a single-element array \`[N]\` plus the same trailing words (for example \`[270] valid series\`), so each task gets its own blocker check, its own pipeline args, and its own worktree lease — never the whole chain's array. Do not run any discover or prepare call against the whole chain at once.

Run \`Workflow(${bootstrapCall("discover", "[N]")})\`. It returns \`{blockerPairs, unblockedNumbers}\` — the blocker check for this one task number, computed in an isolated agent so the raw task list never enters this conversation.

If \`blockerPairs\` is non-empty, call \`Workflow\` with scriptPath \`${blockersWorkflowPath}\`, args \`{ pairs: blockerPairs }\`. It returns \`{ disproven, stillBlocked }\`. For every entry in \`disproven\`, in order, run with Bash:

\`\`\`
node "${blockerVerdictsPath}" <blockedTask> <blockerTask> <<'BLOCKERREASONEOF'
<the entry's reason, verbatim>
BLOCKERREASONEOF
\`\`\`

The delimiter must stay single-quoted so the shell performs no expansion on the reason text. If this task's own entry is left in \`stillBlocked\`, report the open blocker and stop the chain — do not prepare or start the next task number. If \`blockerPairs\` was empty, skip straight to the next paragraph.

Now run \`Workflow(${bootstrapCall("prepare", "[N]")})\`, after any \`disproven\` stripping above so it sees a disproven task as runnable. It returns \`{taskDetails, pipelineArgs, maxConcurrency}\` scoped to this one task: \`taskDetails\` has at most one \`{number, status, task}\` entry (\`status\` is \`"open"\`, \`"completed"\`, or \`"not-found"\`, and \`task\` is that task's record from \`tasks.json\` or \`completedTasks.json\`, or \`null\`); \`pipelineArgs\` is the pipeline arguments described below; \`maxConcurrency\` is the concurrency ceiling for **Running the pipeline**. If \`status\` is \`"completed"\` or \`"not-found"\`, report and explicitly skip this task, then continue with the next task number without launching this task's pipeline.

Invoke \`/ponytail:ponytail ultra\`.

When \`${argsValue}\` contains the word \`valid\`, the user has confirmed the tasks are still relevant — skip the **Verification** section below and treat this task's \`taskDetails\` entry as open and relevant.

## Verification

Review \`taskDetails\` from the prepare result above (its entry's \`task\` comes from \`tasks.json\` if \`status\` is \`"open"\`, or \`completedTasks.json\` if \`"completed"\`). Cross-reference the task with the codebase to determine if the task is still relevant or if it has been resolved.
Use the git history and recent commits (over the last 3 days) to confirm/deny the existence of this task.

${pipelineAndGateSections}
If this task ends with anything unmerged — not approved, rejected at regate, or still in \`unmerged\`/\`cleanupIncomplete\` on \`buildMergeReport\` — stop the chain and report. The next task's blocker is still open, and preparing it against a base this task never landed on wastes the run. Only once this task is fully closed (or explicitly skipped as not-found/completed) do you discover and prepare the next task number in the chain, repeating everything above.

Do the **Commit message** section once, after the last task in the chain, not per task.

${commitMessageSection}`;
  return brief;
};

// RETIRED (task 163): old close-tasks-skill text superseded by task 152's closeTasks.ts call; see git history.  Closed every non-problematic completed task with one \`close-tasks\` skill call; array of task numbers plus closureNote reasoning.  Orchestrator ran typecheck only; workers ran their own tests. Full verification ran once inside \`close-tasks\`, after user approval.

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

if (process.argv[1]?.endsWith("tackle-tasks-v1_1_SkillBodyEmitter.ts")) {
  const argsValue = readStdin().replace(/\n$/, "");
  if (argsValue === "") fail("no arguments on stdin");
  process.stdout.write(skillBody(argsValue));
}
