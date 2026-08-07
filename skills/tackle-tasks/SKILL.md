---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: "[N,N,...] [valid]"
allowed-tools: Bash(git add *), Bash(node *)
---

- blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" '$ARGUMENTS'`

Invocation format: the task numbers come first as a JSON array with **no spaces** — `[268,270,281]` — followed by `valid` and any free text. The scripts above read the whole argument string and stop at the first token that is not part of the array, so anything after it is ignored by them. Avoid apostrophes and backticks in that trailing text; it reaches the shell inside single quotes.

Every task reported BLOCKED above lists its open blocker(s) as a JSON array — investigate before trusting the report. Parse each BLOCKED line's JSON array into one `{ blockedTask, blockerTask, reason }` entry per element (`blockedTask` is the task number named in "task N: BLOCKED", `blockerTask` is that element's `taskNum`, `reason` is that element's `reason` taken verbatim). Call Workflow with scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/blockers.workflow.js`, args `{ pairs }` where `pairs` is the full list built this way across every BLOCKED task above. It returns `{ disproven, stillBlocked }`. For every entry in `disproven`, in order, run with Bash:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/blockerVerdicts.ts" <blockedTask> <blockerTask> <<'BLOCKERREASONEOF'
<the entry's reason, verbatim>
BLOCKERREASONEOF
```

The delimiter must stay single-quoted so the shell performs no expansion on the reason text. Do not work on any task with an entry left in `stillBlocked` — report those open blockers and move on to the next requested task that is unblocked. If nothing was reported BLOCKED, skip straight to the next paragraph.

Now get task details and the pipeline args yourself with Bash, in this order, so both run after any stripping above and see a disproven task as runnable, using only commands that start with `node` (the skill's `allowed-tools` permits `Bash(node *)`, not compound shell commands like `u=$(...)`): first run `node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" --unblocked '$ARGUMENTS'` and read its output. If that output is non-empty, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" <output>`, substituting the exact output text (the space-separated task numbers) in place of `<output>`. If that output is empty, skip that command and report "none of the requested tasks are unblocked" yourself instead. Then, regardless of the previous step, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/prepareTasks.ts" '$ARGUMENTS'`.

Invoke `/ponytail:ponytail ultra`.

When `$ARGUMENTS` contains the word `valid`, the user has confirmed the tasks are still relevant — skip the **Verification** section below and treat every unblocked task in the details above as open and relevant.

## Verification

Review the task details above (each object comes from `tasks.json` if the task is open, or `completedTasks.json` if it was already completed). Cross-reference the task with the codebase to determine if the task is still relevant or if it has been resolved.
Use the git history and recent commits (over the last 3 days) to confirm/deny the existence of the unblocked tasks detailed above.

## Running the pipeline

Each phase is its own workflow, launched in order. Call Workflow with the
scriptPath and args given below, and wait for each to finish before starting
the next.

The "pipeline args" JSON printed above has these keys: `repo`,
`typecheckCommand`, `groups`, `repositorySources`, `repositoryManifest`,
`runId`, `startTimestamp`, `mergeScript`, `stepOutputsFile`, `mergeCommand`.
Every step below passes all of those keys through unchanged, plus the extra
keys named in that step.

`prepareTasks.ts` has already written that whole JSON to disk, so step 6 never
retypes it. `mergeCommand` is the finished command line; `stepOutputsFile` is
the one file step 6 writes.

**Step 1 — plan.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/plan.workflow.js`,
args = the pipeline args JSON exactly as printed, no additions.
Returns `{plans, planned, needsClarification, notRelevant}`.

**Step 2 — verify.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/verify.workflow.js`,
args = the pipeline args JSON plus one added key:
- `planned`: the `planned` array from step 1, verbatim.

Reviews each plan with codex (falls back to fable-medium, then opus 4.8-medium). On a rejection the verifier applies codex's
suggested fixes to the plan file and re-runs codex once; a second rejection is
final. Returns `{verified, approved, rejected, revisedCount, reviewHandoffs}`.
If `approved` is empty, stop and report — there is nothing to implement.
Report `revisedCount` so the user knows how many plan files codex rewrote.
`reviewHandoffs` is one string per verified task recording codex's verdict —
real evidence the approval gate later checks, carried into step 6.

**Step 3 — implement.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/implement.workflow.js`,
args = the pipeline args JSON plus one added key:
- `approved`: the `approved` array from step 2, verbatim.

Returns `{results, done, partial, blocked, requeueCount}`.

**Step 4 — test.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/test.workflow.js`,
args = the pipeline args JSON plus:
- `done`: the `done` array from step 3, verbatim.
- `approved`: the `approved` array from step 2, so a failing test goes back to
  the implementer with the plan it implemented rather than to a cold agent.
- `maxRounds` (optional): test-then-fix rounds before giving up, default 3.

Returns `{tests, allPassed, testReceipts}`. `testReceipts` is one
`{groupId, status}` record per group — real evidence the approval gate later
checks, carried into step 6.

**Step 5 — approval.** Present `needsClarification`, `rejected`, `partial`,
`blocked` and `tests` to the user, and ask every needsClarification question
with AskUserQuestion. **Do not launch the merge workflow until the user
approves the work.**

**Step 6 — merge.** This step is a script you run yourself, not a workflow.
Only after the user approved in step 5.

First, Write the earlier steps' return values verbatim to the `stepOutputsFile`
path from the pipeline args — copy them, compute nothing:

```json
{
  "done": [], "partial": [], "blocked": [],
  "needsClarification": [], "requeueCount": 0,
  "testReceipts": [], "reviewHandoffs": []
}
```

`done`/`partial`/`blocked`/`requeueCount` come from step 3,
`needsClarification` from step 1, `testReceipts` from step 4, `reviewHandoffs`
from step 2. `runMergePhase.ts` derives every count and every merge argument
from that file — see `buildMergeOutcomes` in `scripts/runMergePhase.ts`.

Then run the `mergeCommand` string from the pipeline args, exactly as printed.
It takes no arguments; do not append any.

It prints `{status, result, failure}`. `status` is `"merged"` or `"blocked"`
(the pass/fail rule lives in `judgeMergeRun` in `scripts/runMergePhase.ts`, not
here). On `"merged"` you are done — `result` is the merge result.

On `"blocked"`, launch the unblock workflow — scriptPath
`${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/merge.workflow.js`, args = the
printed `failure` object plus `approvedByUser: true`, plus `decisions` if the
user answered a previous round's questions.

It returns `{fixed, summary, blockers, decisions}`. Do not diagnose or fix
conflicts yourself; that stays in the workflow.

- If `fixed` is `true`, run `mergeCommand` again, unchanged.
- **If `decisions` is non-empty, that is the one you must act on.** Each entry
  is a choice the subagent deliberately refused to make for the user —
  conflicting logic, a missing source branch, something destructive. Ask every
  entry with AskUserQuestion, then launch the unblock workflow again with the
  user's answers as `decisions`.
- `blockers` are non-decision failures. Report them; the merge is incomplete.

A merge that returns a non-empty `decisions` or `blockers` did not finish — do
not report it as merged, and do not invoke close-tasks for its tasks.

Present merged and conflicts to the user. ONLY after the user approves, invoke
close-tasks once for all merged tasks.

There is no serial fallback path. One task or ten, the same code path runs.

## Closing your tasks

Close every task that is not problematic and was completed successfully, rendering its `tasks.json` entry stale, with **one** invocation of the `close-tasks` skill for all of them. Its first argument must be a JSON array of the task numbers with no spaces — `[268,270,281]` — followed by your reasoning for the `closureNote`s, naming each task (`#268 …, #270 …`) when the reasons differ.

If the user requests adding tasks, invoke the `create-task` skill once per task — never edit `tasks.json` directly.

During implementation, you (the orchestrator) run typecheck only — no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + full suite + the repo's UI verification where relevant) still runs once inside `close-tasks`, after the user approves closing.

## Commit message

Finally, stage the changes made this session — which may span multiple git repos or submodules — in each affected repo, but do not commit in any of them. Then invoke the `commit-message` skill to generate a commit-message summary for each affected repo, and show the summaries to the user.
