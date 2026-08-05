# Task 55: Fall back to a Claude reviewer in the verify phase when codex is unavailable

Add support to the review phase for when codex is not available: use opus5-high or fable-medium to review instead, to keep token cost down. Codex can be unavailable for several reasons — api overloaded, usage exceeded, not logged in, binary missing from PATH, rate limited — and the verify phase currently has no path for any of them.

Where it lives: skills/tackle-tasks/verify.workflow.js line 33 builds the single command `codex exec -s read-only <prompt>` and the verifier subagent brief forbids running any other command. When that command fails, the verifier has nowhere to go.

What to build: detect codex unavailability by its exit status and stderr, distinguishing it from a genuine plan rejection — a non-zero exit with no PROBLEMS or FIXES block is unavailability, not a verdict. On unavailability, review the plan with a Claude agent instead, using the same prompt text already built by codexPrompt, called through agent() with model opus and effort high, or model fable and effort medium as the cheaper option. Decide which of those two is the default and say so in the plan. The fallback must return the identical verdict shape the codex path returns — approved or rejected, revised, notes — so the repair round and the rest of the pipeline are unchanged, and it must respect the same never-review-more-than-twice ceiling.

Also surface which reviewer actually ran, so a run reviewed by the fallback is not silently reported as codex-approved: add a reviewer field to the per-task result and mention it in skills/tackle-tasks/SKILL.md step 2.

### skills/tackle-tasks/verify.workflow.js

```
export const meta = {
  name: 'tackle-tasks-verify',
  description: 'Review each plan with codex, apply its suggested fixes once, and re-review before rejecting',
  phases: [{ title: 'Verify', detail: 'one codex verifier per planned task, one repair round each' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const PLANNED = ARGS.planned ?? []
const TASK_BY_NUMBER = new Map((ARGS.groups ?? []).flatMap((g) => g.tasks).map((t) => [t.number, t]))

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    revised: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['task', 'verdict', 'revised', 'notes'],
}

const codexPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, say so explicitly in FIXES instead of inventing a fix.`

const verifierBrief = (t, planFile) => {
  const command = `codex exec -s read-only ${JSON.stringify(codexPrompt(t, planFile))}`
  return `Review the plan for task #${t.number} by running exactly this command:

${command}

Codex prints its verdict on the first line. The only file you may ever edit
is the plan file ${planFile} — never touch a source file, and never run any
command other than the codex command above.

If the first run prints APPROVED:
  return verdict "approved", revised false, and codex's reasoning in notes.

If the first run prints REJECTED:
  it also prints a FIXES section. Apply those fixes to ${planFile} so the plan
  says what codex asked for — edit only that file. Then run the exact same
  codex command a second time against the now-updated plan.

  If the second run prints APPROVED: return verdict "approved", revised true,
  and describe in notes what you changed in the plan.

  If the second run prints REJECTED: return verdict "rejected", revised true,
  and put codex's second-round PROBLEMS and FIXES text in notes verbatim —
  that reason is the only thing anyone sees before the task is skipped.

  If codex said the plan cannot be fixed within the task's owned files, do not
  invent a fix: return verdict "rejected", revised false, and copy that
  explanation into notes.

Never run codex more than twice.
Return {task: ${t.number}, verdict, revised, notes}.`
}

log(`verifying ${PLANNED.length} plan(s) with codex, up to one repair round each`)

const results = await parallel(PLANNED.map((p) => () =>
  agent(verifierBrief(TASK_BY_NUMBER.get(p.task), p.planFile), {
    label: `verify:${p.task}`,
    phase: 'Verify',
    schema: VERIFY_SCHEMA,
  })))

const verified = PLANNED.map((p, i) => results[i] ?? {
  task: p.task,
  verdict: 'rejected',
  revised: false,
  notes: 'verifier agent returned no result (killed, errored, or blocked)',
})

const planFileFor = (task) => PLANNED.find((p) => p.task === task).planFile

return {
  verified,
  approved: verified.filter((v) => v.verdict === 'approved').map((v) => ({ ...v, planFile: planFileFor(v.task) })),
  rejected: verified.filter((v) => v.verdict === 'rejected'),
  revisedCount: verified.filter((v) => v.revised).length,
}

```

### skills/tackle-tasks/SKILL.md

```
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

```
