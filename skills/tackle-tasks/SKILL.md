---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: "[N,N,...] [valid]"
allowed-tools: Bash(git add *)
---

- blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" '$ARGUMENTS'`
- task details (unblocked tasks only): !`u=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" --unblocked '$ARGUMENTS'); [ -n "$u" ] && node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts" "$u" || echo "none of the requested tasks are unblocked"`
- pipeline args: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/prepareTasks.ts" '$ARGUMENTS'`

Invocation format: the task numbers come first as a JSON array with **no spaces** — `[268,270,281]` — followed by `valid` and any free text. The scripts above read the whole argument string and stop at the first token that is not part of the array, so anything after it is ignored by them. Avoid apostrophes and backticks in that trailing text; it reaches the shell inside single quotes.

Do not work on any task reported as BLOCKED in the "blocked status" above — report its open blockers and move on to the next requested task that is unblocked.

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
`typecheckCommand`, `groups`, `repositorySources`, `runId`, `startTimestamp`,
`mergeScript`. Every step below passes all seven of those keys through
unchanged, plus the extra keys named in that step.

**Step 1 — plan.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/plan.workflow.js`,
args = the pipeline args JSON exactly as printed, no additions.
Returns `{plans, planned, needsClarification, notRelevant}`.

**Step 2 — verify.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/verify.workflow.js`,
args = the pipeline args JSON plus one added key:
- `planned`: the `planned` array from step 1, verbatim.

Reviews each plan with codex. On a rejection the verifier applies codex's
suggested fixes to the plan file and re-runs codex once; a second rejection is
final. Returns `{verified, approved, rejected, revisedCount}`. If `approved` is
empty, stop and report — there is nothing to implement. Report `revisedCount`
so the user knows how many plan files codex rewrote.

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

Returns `{tests, allPassed}`.

**Step 5 — approval.** Present `needsClarification`, `rejected`, `partial`,
`blocked` and `tests` to the user, and ask every needsClarification question
with AskUserQuestion. **Do not launch the merge workflow until the user
approves the work.**

**Step 6 — merge.** scriptPath `${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/merge.workflow.js`,
args = the pipeline args JSON plus:
- `approvedByUser`: `true` — only after the user approved in step 5. The
  workflow refuses to merge without it.
- `doneCount`: length of `done` from step 3.
- `partialCount`: length of `partial` from step 3.
- `blockedCount`: length of `blocked` from step 3.
- `needsClarificationCount`: length of `needsClarification` from step 1.
- `rejectedCount`: length of `rejected` from step 2.
- `requeueCount`: `requeueCount` from step 3.

The workflow runs `mergeTaskWorktrees.ts` in a subagent. If that fails —
non-zero exit or a non-empty `conflicts` array — a second subagent diagnoses
the cause and fixes what it can, and the merge script then runs again. Do none
of that yourself; it stays in the workflow.

Returns `{merged, conflicts, fixedBlockers, blockers, decisions, summary}`.

- `fixedBlockers` is `null` when the first run was clean, `true` when a
  subagent cleared the blockers and the retry ran, `false` when it could not.
- **`decisions` is the one you must act on.** Each entry is a choice the
  subagent deliberately refused to make for the user — conflicting logic, a
  missing source branch, something destructive. Ask every entry with
  AskUserQuestion, then launch this step again with the user's answers added
  to the args as `decisions`, so the retry has them.
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

Finally, follow these instructions:

!`cat "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/COMMIT_MESSAGES.md"`
