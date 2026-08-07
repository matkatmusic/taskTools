# Task 70: Investigate blockedBy reasons with subagents during a tackle-tasks run and strip entries whose claim is disproven

## User request

the 'reason' string in a blockedBy entry is used by the main agent to decide if a task should actually be blocked when the task is included in a multi-task run of 'tackle-tasks'.  subagents investigate the reason claim to see if the claim is truthful (blocking) or not and report their findings back. "find out if task N is actually blocked by task M due to <reason>".

Depends on task #69, which adds the `reason` key to each blockedBy entry (`{ taskNum, reason }`). This task consumes that reason.

Current behaviour — a blocker is trusted unconditionally, and there are two independent checks:
- scripts/checkBlockers.ts (whole file, 27 lines) is invoked from the SKILL.md preamble at skills/tackle-tasks/SKILL.md:8-9 as `node checkBlockers.ts '$ARGUMENTS'`. `openBlockersOf(n)` (lines 15-18) returns the requested task's blockedBy entries still present among open tasks; line 24 prints `task ${n}: BLOCKED by open task(s) ${blockers.join(", ")}`. Display only. With `--unblocked` it prints just the runnable numbers, which feed getTaskDetails.ts at SKILL.md:9 — so a blocked task never even has its details fetched.
- skills/tackle-tasks/SKILL.md:14 is the prose refusal: do not work on any task reported as BLOCKED.
- scripts/prepareTasks.ts `selectRequestedTasks` (lines 43-66) is the real enforcement: helper `getOpenBlockers` (lines 37-40) then line 53 `requestedTasks.filter(task => getOpenBlockers(task, openNumbers).length === 0)`. Blocked tasks are silently dropped from `runnableTasks` — unlike the not-open case (49-51) and the no-files case (55-63), this drop throws nothing. Only runnable tasks get worktrees, briefs, plans and groups.

Work to do:

1. New scripts/blockerVerdicts.ts — the single source of truth for the allowed verdict values, so both the subagents and the orchestrator agree on the vocabulary rather than each restating it in prose. It exports the verdict enum, the schema fragment the workflow embeds, and the prompt builder that renders the investigation question naming the blocked task number, the blocker task number, and the reason string. It also exports (and exposes as a CLI, following the argv convention in scripts/getTaskDetails.ts and scripts/unblockDependents.ts) the mutation that removes one specific disproven `{ taskNum, reason }` entry from a given task's blockedBy in tasks.json — locate via resolveTaskFiles(), read via readTaskFile(), write back with `JSON.stringify(tasks, null, 2) + "\n"`, and `delete task.blockedBy` when the array empties, matching scripts/unblockDependents.ts:17-25.

2. New skills/tackle-tasks/blockers.workflow.js — fans out one subagent per (blocked task, blocker) pair. Follow house style already set by skills/tackle-tasks/plan.workflow.js:11-20 (PLAN_SCHEMA) and skills/tackle-tasks/verify.workflow.js:11-21 (VERIFY_SCHEMA): a flat object schema with an id field, an enum verdict field, and a free-text notes field, all listed in `required`; wired via `agent(brief, { label, phase, schema })`; reduced afterwards with `.filter()` into named buckets returned from the workflow. Reuse the same `retryAgent` 3-attempt null-result guard those files use (plan.workflow.js:60-66, verify.workflow.js:89-95) and the same synthesized-fallback idea as verify.workflow.js:104-110 — a subagent that dies must fall back to the conservative verdict (still blocked), never to "not blocked".

3. Decision on a disproven claim: the task joins the run AND the disproven blockedBy entry is stripped from tasks.json via the mutation in (1). Because that write happens before prepareTasks.ts runs, the existing filters in checkBlockers.ts and prepareTasks.ts:53 then naturally see the task as runnable — no change is needed to the filtering logic itself. Do not add a second parallel notion of "runnable" alongside `selectRequestedTasks`.

4. scripts/checkBlockers.ts:24 currently prints only blocker numbers. It must also print each blocker's reason, otherwise the orchestrator has nothing to hand the subagent. Keep the `--unblocked` output format unchanged — SKILL.md:9 pipes it directly into getTaskDetails.ts.

5. skills/tackle-tasks/SKILL.md — the numbered steps are Step 1 plan (line 41), Step 2 verify (45), Step 3 implement (57), Step 4 test (63), Step 5 approval (74), Step 6 merge (79). Blocker checking today lives only in the unnumbered preamble (lines 8-14). The investigation slots into that preamble: after checkBlockers.ts reports blockers-with-reasons, before prepareTasks.ts is invoked at line 10. Update the line 14 refusal prose so a BLOCKED report is only final after its reason survives investigation.

Constraints:
- Conservative default everywhere: absent, malformed, or unreachable verdict means the task stays blocked.
- scripts/prepareTasks.ts is near the 250-line source cap; this task should not need to grow it, and must not if that would breach the cap.
- Do not touch scripts/approvalReadiness.ts — its `blockedBy` is an unrelated ApprovalBlockReason[] on an approval-readiness result, not the task-record field.

### scripts/blockerVerdicts.ts

(missing: file not found on disk)

### scripts/checkBlockers.ts

```
// Reports which requested task numbers are blocked by still-open tasks; stdout feeds a tackle-tasks !`node ...` command.
import { leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

const pair = resolveTaskFiles(process.cwd());
const openTasks = readTaskFile(pair.tasksPath);
const openNumbers = new Set(openTasks.map(t => t.taskNumber));

// --unblocked: print only the unblocked task numbers, space-separated, so the skill preamble can pipe them straight into getTaskDetails.ts.
const unblockedOnly = process.argv.includes("--unblocked");
// No task numbers -> check every open task (mirrors getTaskDetails' no-arg listing).
const named = leadingTaskNumbers(process.argv.slice(2).filter(a => a !== "--unblocked"));
const requested = named.length > 0 ? named : openTasks.map(t => t.taskNumber);
const openBlockersOf = (n: number) => {
  const task = openTasks.find(t => t.taskNumber === n);
  const blockedBy = Array.isArray(task?.blockedBy) ? (task.blockedBy as { taskNum: number }[]) : [];
  return blockedBy.map(b => b.taskNum).filter(b => openNumbers.has(b));
};
if (unblockedOnly) {
  process.stdout.write(requested.filter(n => openBlockersOf(n).length === 0).join(" ") + "\n");
} else {
  const lines = requested.map(n => {
    const blockers = openBlockersOf(n);
    return blockers.length > 0 ? `task ${n}: BLOCKED by open task(s) ${blockers.join(", ")}` : `task ${n}: unblocked`;
  });
  process.stdout.write((lines.length > 0 ? lines.join("\n") : "no task numbers given") + "\n");
}

```

### skills/tackle-tasks/blockers.workflow.js

(missing: file not found on disk)

### skills/tackle-tasks/SKILL.md

```
---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: "[N,N,...] [valid]"
allowed-tools: Bash(git add *), Bash(node *)
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

Finally, follow these instructions:

!`cat "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/COMMIT_MESSAGES.md"`

```

### tests/blockerVerdicts.test.ts

(missing: file not found on disk)

### tests/checkBlockers.test.ts

```
// checkBlockers.ts: a task is BLOCKED only by still-open blockers; closed ones don't count. Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "checkBlockers.ts");

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "taskTools-checkBlockers-"));
  writeFileSync(
    join(root, "tasks.json"),
    JSON.stringify([
      { taskNumber: 1, title: "open blocker" },
      { taskNumber: 2, title: "blocked by open task", blockedBy: [{ taskNum: 1, reason: "needs task 1" }] },
      { taskNumber: 4, title: "blocked only by closed task", blockedBy: [{ taskNum: 3, reason: "needs task 3" }] },
    ]),
  );
  writeFileSync(join(root, "completedTasks.json"), JSON.stringify([{ taskNumber: 3, title: "closed blocker" }]));
  return root;
}

function runScript(cwd: string, ...args: string[]): string {
  return execFileSync("node", ["--no-inspect", SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("flags open blockers, ignores closed ones, passes unblocked tasks", () => {
  const out = runScript(makeProjectRoot(), "2", "4", "1");
  assert.match(out, /task 2: BLOCKED by open task\(s\) 1/);
  assert.match(out, /task 4: unblocked/);
  assert.match(out, /task 1: unblocked/);
});

test("--unblocked prints only unblocked numbers, space-separated", () => {
  const out = runScript(makeProjectRoot(), "--unblocked", "2", "4", "1");
  assert.equal(out, "4 1\n");
});

test("no task numbers checks every open task", () => {
  const out = runScript(makeProjectRoot());
  assert.match(out, /task 1: unblocked/);
  assert.match(out, /task 2: BLOCKED by open task\(s\) 1/);
  assert.match(out, /task 4: unblocked/);
});

test("non-numeric args like 'valid' are ignored", () => {
  const out = runScript(makeProjectRoot(), "2", "valid");
  assert.equal(out, "task 2: BLOCKED by open task(s) 1\n");
});

test("digits after prose are not task numbers, even as one quoted string", () => {
  const out = runScript(makeProjectRoot(), "2 valid see task 4 from 2026-07-21");
  assert.equal(out, "task 2: BLOCKED by open task(s) 1\n");
});

```

### skills/tackle-tasks/plan.workflow.js

```
export const meta = {
  name: 'tackle-tasks-plan',
  description: 'Write one plan file per task, one planner agent each',
  phases: [{ title: 'Plan', detail: 'one planner agent per task' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const GROUPS = ARGS.groups ?? []
const PLAN_MODEL = ARGS.planModel

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    status: { type: 'string', enum: ['planned', 'needs-clarification', 'not-relevant'] },
    planFile: { type: 'string' },
    question: { type: 'string' },
    missingFiles: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['task', 'status', 'planFile', 'question'],
}

const fileRetryPreamble = (t, missingFiles) => `Before planning, run these two commands with Bash from ${ARGS.repo} to gain read access to the files you flagged as missing, then continue below:

1. cd ${ARGS.repo} && node "scripts/addTaskFiles.ts" '[${t.number}]' ${missingFiles.map((f) => JSON.stringify(f)).join(' ')}
2. cd ${ARGS.repo} && node -e "(async()=>{const {resolveTaskFiles,readTaskFile}=await import('./scripts/taskFiles.ts');const {writeTaskBriefFile}=await import('./scripts/prepareTasks.ts');const pair=resolveTaskFiles(process.cwd());const task=readTaskFile(pair.tasksPath).find(x=>x.taskNumber===${t.number});if(!task)throw new Error('task ${t.number} disappeared from tasks.json');writeTaskBriefFile(task,process.cwd());console.log(JSON.stringify(task.files));})()"

Command 1 adds the missing paths to this task's owned files in tasks.json.
Command 2 regenerates plans/brief-${t.number}.md from the updated task record and prints
the task's full current owned-files list as a JSON array on stdout — record that array,
you will return it as "files" below.

`

const testsInstruction = (t) => t.tests && t.tests !== 'skip'
  ? `The task's tests field holds an example test the user wrote — put it into the plan's verification section as the concrete check to run, expanded with a few extra cases covering the individual functions/subparts it touches: ${t.tests}`
  : 'This task has no tests field, or it is the literal string "skip" — do not require TDD; write ordinary verification commands in the plan instead.'

const plannerBrief = (t, preamble = '') => `${preamble}Invoke /ponytail:ponytail ultra.
Read this brief file: ${t.briefFile}
You may also READ these owned files, and nothing else: ${t.files.join(', ')}
Read them — a plan that guesses at their contents will be rejected by the reviewer.
Follow ~/.claude/guides/planning.md and write the plan to exactly this path: ${t.planFile}
Do not change any source file — this is planning only, not implementation.

The plan must be exact enough that the implementer makes no discovery of its own:
- Name every edit by file path and line number, with the current text and what it becomes.
- Account for every owned file: either its exact edit list, or the reason it needs no edit.
- Resolve every question while planning. Write no conditional instruction — no
  "re-check", no "verify before editing", no "if the live file disagrees", no
  "trust the live file". If you could not settle something, that is
  needs-clarification, not a fallback sentence in the plan.
- Quote only text you actually read. Never describe an excerpt the brief does not contain.
- State the verification that proves the change worked, as commands with expected results.
- ${testsInstruction(t)}

If the plan would need to edit a file outside the owned list above, set status
"needs-clarification" and name that file in "question" — do not plan the edit anyway.
If the blocker is instead that you need to READ a file outside the owned list
to write an exact plan, set status "needs-clarification", populate
missingFiles with the repo-relative path(s) of each file you need, and use
"question" to explain why each path is needed.
If the task is unclear, set status "needs-clarification" and put your
question in "question". If the task no longer applies to the codebase, set
status "not-relevant" and explain why in "question". Otherwise write the
plan file and set status "planned".
Return {task: ${t.number}, status, planFile: "${t.planFile}", question, missingFiles}.
${preamble ? `Also return "files": the JSON array command 2 above printed.\n` : ''}
You are forbidden to edit any file other than ${t.planFile}${preamble ? ', tasks.json, and plans/brief-*.md — those only via the two commands given above' : ''}; to read a file outside
the owned list; to leave a decision for the implementer; or to write a plan step
whose exact target you did not read.`

const TASKS = GROUPS.flatMap((g) => g.tasks)
log(`planning ${TASKS.length} task(s)`)

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

const runPlanner = (t, preamble = '') => {
  const options = { label: `plan:${t.number}`, phase: 'Plan', schema: PLAN_SCHEMA }
  if (PLAN_MODEL) options.model = PLAN_MODEL
  return retryAgent(() => agent(plannerBrief(t, preamble), options))
}

const results = await parallel(TASKS.map((t) => () => runPlanner(t)))
const firstPass = TASKS.map((t, i) => results[i] ?? {
  task: t.number,
  status: 'needs-clarification',
  planFile: '',
  question: 'planner returned no result after 3 attempts',
})

// Retries a needs-clarification verdict, not a null result; distinct from retryAgent above.
const needsFileRetry = (p) => p.status === 'needs-clarification' && Array.isArray(p.missingFiles) && p.missingFiles.length > 0

const retryWithFiles = async (t, p) => {
  const readableTask = { ...t, files: [...new Set([...t.files, ...p.missingFiles])] }
  const retryResult = await runPlanner(readableTask, fileRetryPreamble(t, p.missingFiles))
  t.files = [...new Set([
    ...t.files,
    ...(Array.isArray(retryResult?.files) ? retryResult.files : p.missingFiles),
  ])]
  return retryResult ?? {
    task: t.number,
    status: 'needs-clarification',
    planFile: '',
    question: 'planner returned no result after 3 attempts on file retry',
  }
}

const plans = []
for (let i = 0; i < TASKS.length; i++) {
  const result = firstPass[i]
  plans.push(needsFileRetry(result)
    ? await retryWithFiles(TASKS[i], result)
    : result)
}

return {
  plans,
  planned: plans.filter((p) => p.status === 'planned'),
  needsClarification: plans.filter((p) => p.status === 'needs-clarification'),
  notRelevant: plans.filter((p) => p.status === 'not-relevant'),
}

```

### skills/tackle-tasks/verify.workflow.js

```
export const meta = {
  name: 'tackle-tasks-verify',
  description: 'Review each plan with codex (or Claude when codex is down), apply its fixes once, and re-review before rejecting',
  phases: [{ title: 'Verify', detail: 'one verifier per planned task, one repair round each' }],
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
    reviewer: { type: 'string', enum: ['codex', 'claude'] },
  },
  required: ['task', 'verdict', 'revised', 'notes', 'reviewer'],
}

const codexPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, say so explicitly in FIXES instead of inventing a fix.`

const verifierBrief = (t, planFile) => {
  const prompt = JSON.stringify(codexPrompt(t, planFile))
  const command = `codex exec -s read-only ${prompt}`
  // ponytail: opus/high, not fable/medium — the fallback replaces the strictest gate in the pipeline
  const opusFallbackCommand = `claude -p ${prompt} --tools "Read" --model claude-opus-4-8 --effort high`
  const fableFallbackCommand = `claude -p ${prompt} --tools "Read" --model fable --effort medium`
  return `Review the plan for task #${t.number} by running exactly this command:

${command}

If that command exits with an error code, codex is unavailable — not a
verdict. Unavailability looks like a non-zero exit with no APPROVED or
REJECTED first line and no PROBLEMS or FIXES block: overloaded api, usage
exceeded, not logged in, rate limited, or no codex binary on PATH. In that
case run this command instead, and treat its output exactly as you would
codex's:

${fableFallbackCommand}
if that command also exits with an error code, run this command instead, and treat its output exactly as you would codex's:

${opusFallbackCommand}

Whichever reviewer answers prints its verdict on the first line. The only
file you may ever edit is the plan file ${planFile} — never touch a source
file, and never run any command other than the two above.

Report which reviewer actually produced the verdict you return: reviewer
"codex" if the codex command answered, reviewer "claude" if you had to fall
back. Never report a fallback review as codex.

If the first run prints APPROVED:
  return verdict "approved", revised false, and the reviewer's reasoning in notes.

If the first run prints REJECTED:
  it also prints a FIXES section. Apply those fixes to ${planFile} so the plan
  says what the reviewer asked for — edit only that file. Then run that same
  reviewer's command a second time against the now-updated plan.

  If the second run prints APPROVED: return verdict "approved", revised true,
  and describe in notes what you changed in the plan.

  If the second run prints REJECTED: return verdict "rejected", revised true,
  and put the reviewer's second-round PROBLEMS and FIXES text in notes verbatim —
  that reason is the only thing anyone sees before the task is skipped.

  If the reviewer said the plan cannot be fixed within the task's owned files, do
  not invent a fix: return verdict "rejected", revised false, and copy that
  explanation into notes.

Never review more than twice in total, counting codex and the fallback together.
Return {task: ${t.number}, verdict, revised, notes, reviewer}.`
}

log(`verifying ${PLANNED.length} plan(s) with codex, up to one repair round each`)

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

const results = await parallel(PLANNED.map((p) => () =>
  retryAgent(() => agent(verifierBrief(TASK_BY_NUMBER.get(p.task), p.planFile), {
    label: `verify:${p.task}`,
    phase: 'Verify',
    schema: VERIFY_SCHEMA,
  }))))

const verified = PLANNED.map((p, i) => results[i] ?? {
  task: p.task,
  verdict: 'rejected',
  revised: false,
  notes: 'verifier agent returned no result after 3 attempts (killed, errored, or blocked)',
  reviewer: 'none',
})

const planFileFor = (task) => PLANNED.find((p) => p.task === task).planFile

const reviewHandoffs = verified.map((v) => `task ${v.task}: ${v.verdict} by ${v.reviewer}${v.revised ? ' (revised)' : ''} - ${v.notes}`)

return {
  verified,
  approved: verified.filter((v) => v.verdict === 'approved').map((v) => ({ ...v, planFile: planFileFor(v.task) })),
  rejected: verified.filter((v) => v.verdict === 'rejected'),
  revisedCount: verified.filter((v) => v.revised).length,
  reviewHandoffs,
}

```

### scripts/unblockDependents.ts

```
// Removes closed task numbers from blockedBy arrays; CLI below re-reads/rewrites tasks.json standalone.
import { writeFileSync } from "node:fs";
import { readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export function unblockDependents(tasks: any[], closedTaskNumbers: number[]): number[] {
  const closed = new Set(closedTaskNumbers.map(Number));
  const unblocked: number[] = [];
  for (const t of tasks) {
    if (!Array.isArray(t.blockedBy)) continue;
    const entries = t.blockedBy as (number | { taskNum: number; reason: string })[];
    let taskMigrated = false;
    const upgraded = entries.map((entry) => {
      if (typeof entry === "number") {
        taskMigrated = true;
        return { taskNum: entry, reason: "reason not recorded (migrated from legacy blockedBy format)" };
      }
      return entry;
    });
    const remaining = upgraded.filter((entry) => !closed.has(entry.taskNum));
    const taskUnblocked = remaining.length !== upgraded.length;
    if (!taskMigrated && !taskUnblocked) continue;
    if (taskUnblocked) unblocked.push(t.taskNumber);
    if (remaining.length === 0) delete t.blockedBy;
    else t.blockedBy = remaining;
  }
  return unblocked;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const closed = new Set((process.argv.slice(2).join(" ").match(/\d+/g) ?? []).map(Number));
  if (closed.size === 0) {
    process.stderr.write("usage: node unblockDependents.ts <taskNumber...>\n");
    process.exit(1);
  }

  const { tasksPath } = resolveTaskFiles(process.cwd());
  const tasks = readTaskFile(tasksPath);
  const before = JSON.stringify(tasks);
  const unblocked = unblockDependents(tasks, [...closed]);
  if (JSON.stringify(tasks) !== before) writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
  process.stdout.write((unblocked.length > 0 ? `removed closed task(s) from blockedBy of task(s): ${unblocked.join(", ")}` : "no blockedBy references to the closed task(s)") + "\n");
}

```

### scripts/getTaskDetails.ts

```
// Task lookup helpers, plus a CLI that prints them to stdout for skill injection.
import { type TaskRecord, leadingTaskNumbers, readTaskFile, resolveTaskFiles } from "./taskFiles.ts";

export function describeTask(taskNumber: number, openTasks: TaskRecord[], completedTasks: TaskRecord[]): string {
  const open = openTasks.find(t => t.taskNumber === taskNumber);
  if (open) return `task ${taskNumber} (OPEN):\n${JSON.stringify(open, null, 2)}`;
  const completed = completedTasks.find(t => t.taskNumber === taskNumber);
  if (completed) return `task ${taskNumber} (COMPLETED):\n${JSON.stringify(completed, null, 2)}`;
  return `task ${taskNumber}: not found in tasks.json or completedTasks.json`;
}

export function listTaskTitles(tag: string, tasks: TaskRecord[]): string[] {
  return tasks.map(t => {
    const blockedBy = Array.isArray(t.blockedBy) ? (t.blockedBy as { taskNum: number; reason: string }[]) : [];
    const blockers = blockedBy.length > 0 ? ` [blockedBy: ${blockedBy.map(b => `${b.taskNum} (${b.reason})`).join(", ")}]` : "";
    return `${tag} ${t.taskNumber}: ${t.title}${blockers}`;
  });
}

export function readTaskLists(projectRoot: string = process.cwd()): {
  openTasks: TaskRecord[];
  completedTasks: TaskRecord[];
} {
  const pair = resolveTaskFiles(projectRoot);
  return { openTasks: readTaskFile(pair.tasksPath), completedTasks: readTaskFile(pair.completedTasksPath) };
}

// Open tasks win over completed ones, matching describeTask's lookup order.
export function findTask(taskNumber: number, projectRoot: string = process.cwd()): TaskRecord | undefined {
  const { openTasks, completedTasks } = readTaskLists(projectRoot);
  return openTasks.find(t => t.taskNumber === taskNumber) ?? completedTasks.find(t => t.taskNumber === taskNumber);
}

export function taskDetailsReport(taskNumbers: number[], projectRoot: string = process.cwd()): string {
  const { openTasks, completedTasks } = readTaskLists(projectRoot);
  const report =
    taskNumbers.length === 0
      ? [...listTaskTitles("OPEN", openTasks), ...listTaskTitles("DONE", completedTasks)]
      : taskNumbers.map(n => describeTask(n, openTasks, completedTasks));
  return report.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(taskDetailsReport(leadingTaskNumbers(process.argv.slice(2))));
}

```
