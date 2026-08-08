# Task 75: Move the tackle-tasks skill body into a script that emits it as a literal brief

## Note on the brief's staleness

`plans/brief-75.md` quotes a "Current state" snapshot of `skills/tackle-tasks/SKILL.md` that
**is** byte-identical to the live file (verified with `diff` below), so that quoted block is
trustworthy. But the brief's own prose above it — "Four shell substitutions the script must
handle" — describes an *older* draft of the file and is stale on two points:

- Item 4 (`cat ".../COMMIT_MESSAGES.md"`) does not exist anywhere in the live file. Task #62
  already landed and replaced the `cat` line with a plain instruction to invoke the
  `commit-message` skill (present live at line 147). `skills/tackle-tasks/COMMIT_MESSAGES.md`
  does not exist on disk (confirmed with `ls`). **No edit needed for this item — it is already
  gone.**
- Item 2 (the compound `u=$(...); [ -n "$u" ] && ... || ...` one-liner) does not exist either.
  Task #70 already landed and replaced it with the current live lines 22 ("Now get task details
  and the pipeline args yourself with Bash...") and the surrounding prose, which explicitly says
  to use only single `node ...` commands because `allowed-tools` is `Bash(node *)`, not compound
  shell. **There is no compound one-liner left to shell out verbatim — the brief's "Decision
  taken" paragraph is describing a form of the file that no longer exists.**

This plan follows the live file (per the user's global instruction: source code is the truth,
not `.md` docs) rather than the brief's stale "Four shell substitutions" prose. The live file's
own quoted "Current state" block in the brief matches what was read from disk, confirming tasks
#62 and #70 have already landed — the ordering constraint in the brief ("two open tasks also
edit skills/tackle-tasks/SKILL.md and must land first") is already satisfied.

Live file facts used throughout this plan (verified):
- `skills/tackle-tasks/SKILL.md` is 147 lines, 9692 bytes, ends with a single trailing newline
  (no blank line after the last sentence) — confirmed with `wc -l`, `wc -c`, `xxd`.
- `scripts/tackleTasksBrief.ts` and `tests/tackleTasksBrief.test.ts` do not exist (confirmed
  with `ls`, both report "No such file or directory") — both are new files.
- All ten scripts/workflows the brief references exist on disk: `scripts/checkBlockers.ts`,
  `scripts/blockerVerdicts.ts`, `scripts/getTaskDetails.ts`, `scripts/prepareTasks.ts`,
  `skills/tackle-tasks/blockers.workflow.js`, `skills/tackle-tasks/plan.workflow.js`,
  `skills/tackle-tasks/verify.workflow.js`, `skills/tackle-tasks/implement.workflow.js`,
  `skills/tackle-tasks/test.workflow.js`, `skills/tackle-tasks/merge.workflow.js`.

## What actually needs converting

Enumerating every `${CLAUDE_PLUGIN_ROOT}` and every `$ARGUMENTS` occurrence in the live 147-line
file (this replaces the brief's stale 4-item list):

`${CLAUDE_PLUGIN_ROOT}` occurrences (11 total occurrences resolving to 10 unique paths, all become
resolved absolute paths):
- line 8: `scripts/checkBlockers.ts` (also reused at line 22)
- line 12: `skills/tackle-tasks/blockers.workflow.js`
- line 15: `scripts/blockerVerdicts.ts`
- line 22: `scripts/checkBlockers.ts` (again, `--unblocked` variant — same file as line 8)
- line 22: `scripts/getTaskDetails.ts`
- line 22: `scripts/prepareTasks.ts`
- line 49: `skills/tackle-tasks/plan.workflow.js`
- line 53: `skills/tackle-tasks/verify.workflow.js`
- line 65: `skills/tackle-tasks/implement.workflow.js`
- line 71: `skills/tackle-tasks/test.workflow.js`
- line 114: `skills/tackle-tasks/merge.workflow.js`

`$ARGUMENTS` occurrences (4 total, all become the literal argument string read from stdin):
- line 8: `'$ARGUMENTS'` (inside the `checkBlockers.ts` call — this whole line becomes the
  pre-computed "blocked status" embed, mirroring `taskStatsBrief.ts`'s embed of `taskStats.ts`)
- line 22: `'$ARGUMENTS'` (in the `checkBlockers.ts --unblocked` command)
- line 22: `'$ARGUMENTS'` (in the `prepareTasks.ts` command)
- line 26: `` `$ARGUMENTS` `` (in the prose "When `$ARGUMENTS` contains the word `valid`...")

Every other line of the 147 is copied byte-for-byte, with every literal backtick character
escaped as `` \` `` because the whole body becomes one JS template literal.

This was built and verified mechanically (not hand-transcribed) in the scratchpad using `sd` to
escape every backtick and substitute the 10 path occurrences and the argsValue occurrences, then
diffed the unresolved output back against the live file — the diff showed changes at exactly the
14 lines listed above and nowhere else. It was then executed end-to-end (heredoc stdin →
`checkBlockers.ts` subprocess → embedded brief) against the real files in this repo and produced
correct output with no `CLAUDE_PLUGIN_ROOT` or `$ARGUMENTS` left in it.

## Edit 1 (new file): `scripts/tackleTasksBrief.ts`

Create this file with exactly this content:

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand.
const checkBlockersPath = fileURLToPath(new URL("./checkBlockers.ts", import.meta.url));
const blockerVerdictsPath = fileURLToPath(new URL("./blockerVerdicts.ts", import.meta.url));
const getTaskDetailsPath = fileURLToPath(new URL("./getTaskDetails.ts", import.meta.url));
const prepareTasksPath = fileURLToPath(new URL("./prepareTasks.ts", import.meta.url));
const blockersWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/blockers.workflow.js", import.meta.url));
const planWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/plan.workflow.js", import.meta.url));
const verifyWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/verify.workflow.js", import.meta.url));
const implementWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/implement.workflow.js", import.meta.url));
const testWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/test.workflow.js", import.meta.url));
const mergeWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/merge.workflow.js", import.meta.url));

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

## Verification

Review the task details above (each object comes from \`tasks.json\` if the task is open, or \`completedTasks.json\` if it was already completed). Cross-reference the task with the codebase to determine if the task is still relevant or if it has been resolved.
Use the git history and recent commits (over the last 3 days) to confirm/deny the existence of the unblocked tasks detailed above.

## Running the pipeline

Each phase is its own workflow, launched in order. Call Workflow with the
scriptPath and args given below, and wait for each to finish before starting
the next.

The "pipeline args" JSON printed above has these keys: \`repo\`,
\`typecheckCommand\`, \`groups\`, \`repositorySources\`, \`repositoryManifest\`,
\`runId\`, \`startTimestamp\`, \`mergeScript\`, \`stepOutputsFile\`, \`mergeCommand\`.
Every step below passes all of those keys through unchanged, plus the extra
keys named in that step.

\`prepareTasks.ts\` has already written that whole JSON to disk, so step 6 never
retypes it. \`mergeCommand\` is the finished command line; \`stepOutputsFile\` is
the one file step 6 writes.

**Step 1 — plan.** scriptPath \`${planWorkflowPath}\`,
args = the pipeline args JSON exactly as printed, no additions.
Returns \`{plans, planned, needsClarification, notRelevant}\`.

**Step 2 — verify.** scriptPath \`${verifyWorkflowPath}\`,
args = the pipeline args JSON plus one added key:
- \`planned\`: the \`planned\` array from step 1, verbatim.

Reviews each plan with codex (falls back to fable-medium, then opus 4.8-medium). On a rejection the verifier applies codex's
suggested fixes to the plan file and re-runs codex once; a second rejection is
final. Returns \`{verified, approved, rejected, revisedCount, reviewHandoffs}\`.
If \`approved\` is empty, stop and report — there is nothing to implement.
Report \`revisedCount\` so the user knows how many plan files codex rewrote.
\`reviewHandoffs\` is one string per verified task recording codex's verdict —
real evidence the approval gate later checks, carried into step 6.

**Step 3 — implement.** scriptPath \`${implementWorkflowPath}\`,
args = the pipeline args JSON plus one added key:
- \`approved\`: the \`approved\` array from step 2, verbatim.

Returns \`{results, done, partial, blocked, requeueCount}\`.

**Step 4 — test.** scriptPath \`${testWorkflowPath}\`,
args = the pipeline args JSON plus:
- \`done\`: the \`done\` array from step 3, verbatim.
- \`approved\`: the \`approved\` array from step 2, so a failing test goes back to
  the implementer with the plan it implemented rather than to a cold agent.
- \`maxRounds\` (optional): test-then-fix rounds before giving up, default 3.

Returns \`{tests, allPassed, testReceipts}\`. \`testReceipts\` is one
\`{groupId, status}\` record per group — real evidence the approval gate later
checks, carried into step 6.

**Step 5 — approval.** Present \`needsClarification\`, \`rejected\`, \`partial\`,
\`blocked\` and \`tests\` to the user, and ask every needsClarification question
with AskUserQuestion. **Do not launch the merge workflow until the user
approves the work.**

**Step 6 — merge.** This step is a script you run yourself, not a workflow.
Only after the user approved in step 5.

First, Write the earlier steps' return values verbatim to the \`stepOutputsFile\`
path from the pipeline args — copy them, compute nothing:

\`\`\`json
{
  "done": [], "partial": [], "blocked": [],
  "needsClarification": [], "requeueCount": 0,
  "testReceipts": [], "reviewHandoffs": []
}
\`\`\`

\`done\`/\`partial\`/\`blocked\`/\`requeueCount\` come from step 3,
\`needsClarification\` from step 1, \`testReceipts\` from step 4, \`reviewHandoffs\`
from step 2. \`runMergePhase.ts\` derives every count and every merge argument
from that file — see \`buildMergeOutcomes\` in \`scripts/runMergePhase.ts\`.

Then run the \`mergeCommand\` string from the pipeline args, exactly as printed.
It takes no arguments; do not append any.

It prints \`{status, result, failure}\`. \`status\` is \`"merged"\` or \`"blocked"\`
(the pass/fail rule lives in \`judgeMergeRun\` in \`scripts/runMergePhase.ts\`, not
here). On \`"merged"\` you are done — \`result\` is the merge result.

On \`"blocked"\`, launch the unblock workflow — scriptPath
\`${mergeWorkflowPath}\`, args = the
printed \`failure\` object plus \`approvedByUser: true\`, plus \`decisions\` if the
user answered a previous round's questions.

It returns \`{fixed, summary, blockers, decisions}\`. Do not diagnose or fix
conflicts yourself; that stays in the workflow.

- If \`fixed\` is \`true\`, run \`mergeCommand\` again, unchanged.
- **If \`decisions\` is non-empty, that is the one you must act on.** Each entry
  is a choice the subagent deliberately refused to make for the user —
  conflicting logic, a missing source branch, something destructive. Ask every
  entry with AskUserQuestion, then launch the unblock workflow again with the
  user's answers as \`decisions\`.
- \`blockers\` are non-decision failures. Report them; the merge is incomplete.

A merge that returns a non-empty \`decisions\` or \`blockers\` did not finish — do
not report it as merged, and do not invoke close-tasks for its tasks.

Present merged and conflicts to the user. ONLY after the user approves, invoke
close-tasks once for all merged tasks.

There is no serial fallback path. One task or ten, the same code path runs.

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
      `usage: node tackleTasksBrief.ts <<'TACKLETASKSEOF'\n<task numbers as JSON array> [valid] [free text...]\nTACKLETASKSEOF\n`,
  );
  process.exit(1);
}

if (process.argv[1]?.endsWith("tackleTasksBrief.ts")) {
  const argsValue = readStdin().replace(/\n$/, "");
  if (argsValue === "") fail("no arguments on stdin");
  const blockedStatus = execFileSync("node", [checkBlockersPath, argsValue], { encoding: "utf8" }).trimEnd();
  process.stdout.write(tackleTasksBrief(argsValue, blockedStatus));
}
```

Notes on this content, since every line must be justified:
- `fail` mirrors `scripts/reviewPlanBrief.ts` lines 123-130: same loud-failure shape (write to
  stderr, print a usage line, `process.exit(1)`), same "arguments arrive on stdin, so an empty
  read must stop here" comment, adapted only in the problem string and usage text — this script
  has one failure mode (empty stdin), not three, so it has one `fail(...)` call instead of
  `reviewPlanBrief.ts`'s three.
- The `checkBlockersPath` constant is reused for both the line-8 embed and the line-22
  `--unblocked` command — it is the same file in the live source, so one constant, referenced
  twice, is correct (not a bug to fix, this mirrors the live file's own reuse).
- `readStdin()` is copied verbatim from `scripts/reviewPlanBrief.ts` lines 115-121 (same body,
  same try/catch-returns-empty-string shape) — this is the "mirror its stdin read" instruction
  from the brief, applied to the live pattern.
- `argsValue` strips exactly one trailing newline (the one the heredoc always appends after
  `$ARGUMENTS`), not a general trim — this was verified against the live file: the old inline
  `'$ARGUMENTS'` substitutions never trimmed anything, so over-trimming would change behavior.
- `tackleTasksBrief` is exported as a pure function of `(argsValue, blockedStatus)`, not a
  precomputed constant — unlike `taskStatsBrief.ts` (which has no input), this brief depends on
  stdin, so it must follow `reviewPlanBrief.ts`'s pattern of a function computed only inside the
  CLI guard, keeping the module cleanly unit-testable without a subprocess.
- The `if (process.argv[1]?.endsWith("tackleTasksBrief.ts"))` guard matches the exact pattern
  used in both `taskStatsBrief.ts` (line 14) and `reviewPlanBrief.ts` (line 132).

## Edit 2 (new file): `tests/tackleTasksBrief.test.ts`

Create this file with exactly this content:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tackleTasksBrief } from "../scripts/tackleTasksBrief.ts";

const scriptPath = fileURLToPath(new URL("../scripts/tackleTasksBrief.ts", import.meta.url));
const checkBlockersPath = fileURLToPath(new URL("../scripts/checkBlockers.ts", import.meta.url));
const blockerVerdictsPath = fileURLToPath(new URL("../scripts/blockerVerdicts.ts", import.meta.url));
const getTaskDetailsPath = fileURLToPath(new URL("../scripts/getTaskDetails.ts", import.meta.url));
const prepareTasksPath = fileURLToPath(new URL("../scripts/prepareTasks.ts", import.meta.url));
const blockersWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/blockers.workflow.js", import.meta.url));
const planWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/plan.workflow.js", import.meta.url));
const verifyWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/verify.workflow.js", import.meta.url));
const implementWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/implement.workflow.js", import.meta.url));
const testWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/test.workflow.js", import.meta.url));
const mergeWorkflowPath = fileURLToPath(new URL("../skills/tackle-tasks/merge.workflow.js", import.meta.url));

function runScript(argumentString: string): string {
  return execFileSync("node", [scriptPath], { input: `${argumentString}\n`, encoding: "utf8" });
}

// Mirrors runExpectingFailure in tests/reviewPlanBrief.test.ts lines 84-91.
function runScriptExpectingFailure(input: string): string {
  try {
    execFileSync("node", [scriptPath], { input, encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    return String((error as { stderr: string }).stderr);
  }
  return "";
}

test("brief embeds the blocked-status line under the label", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.ok(brief.startsWith("- blocked status: task 1: unblocked\n"));
});

test("brief substitutes the literal argument string for every $ARGUMENTS occurrence and leaves none literal", () => {
  const brief = tackleTasksBrief("[1,2] valid free text", "status");
  assert.ok(brief.includes("--unblocked '[1,2] valid free text'"));
  assert.ok(brief.includes('prepareTasks.ts" \'[1,2] valid free text\''));
  assert.ok(brief.includes("When `[1,2] valid free text` contains the word `valid`"));
  assert.doesNotMatch(brief, /\$ARGUMENTS/);
});

test("brief resolves every CLAUDE_PLUGIN_ROOT placeholder to an absolute path", () => {
  const brief = tackleTasksBrief("[1]", "status");
  assert.doesNotMatch(brief, /CLAUDE_PLUGIN_ROOT/);
  assert.match(brief, /scriptPath `\/[^`]*plan\.workflow\.js`/);
  assert.match(brief, /scriptPath `\/[^`]*verify\.workflow\.js`/);
  assert.match(brief, /scriptPath `\/[^`]*implement\.workflow\.js`/);
  assert.match(brief, /scriptPath `\/[^`]*test\.workflow\.js`/);
  assert.match(brief, /`\/[^`]*merge\.workflow\.js`/);
});

test("brief keeps the pipeline and closing instructions verbatim", () => {
  const brief = tackleTasksBrief("[1]", "status");
  assert.ok(brief.includes("There is no serial fallback path. One task or ten, the same code path runs."));
  assert.ok(brief.includes("Then invoke the `commit-message` skill to generate a commit-message summary for each affected repo, and show the summaries to the user."));
});

test("running the script end to end embeds the live checkBlockers.ts output for the given arguments", () => {
  const argsValue = "[1] valid";
  const expectedStatus = execFileSync("node", [checkBlockersPath, argsValue], { encoding: "utf8" }).trimEnd();
  const output = runScript(argsValue);
  assert.ok(output.startsWith(`- blocked status: ${expectedStatus}\n`));
});

const expectedBrief = `- blocked status: task 1: unblocked

Invocation format: the task numbers come first as a JSON array with **no spaces** — \`[268,270,281]\` — followed by \`valid\` and any free text. The scripts above read the whole argument string and stop at the first token that is not part of the array, so anything after it is ignored by them. Avoid apostrophes and backticks in that trailing text; it reaches the shell inside single quotes.

Every task reported BLOCKED above lists its open blocker(s) as a JSON array — investigate before trusting the report. Parse each BLOCKED line's JSON array into one \`{ blockedTask, blockerTask, reason }\` entry per element (\`blockedTask\` is the task number named in "task N: BLOCKED", \`blockerTask\` is that element's \`taskNum\`, \`reason\` is that element's \`reason\` taken verbatim). Call Workflow with scriptPath \`${blockersWorkflowPath}\`, args \`{ pairs }\` where \`pairs\` is the full list built this way across every BLOCKED task above. It returns \`{ disproven, stillBlocked }\`. For every entry in \`disproven\`, in order, run with Bash:

\`\`\`
node "${blockerVerdictsPath}" <blockedTask> <blockerTask> <<'BLOCKERREASONEOF'
<the entry's reason, verbatim>
BLOCKERREASONEOF
\`\`\`

The delimiter must stay single-quoted so the shell performs no expansion on the reason text. Do not work on any task with an entry left in \`stillBlocked\` — report those open blockers and move on to the next requested task that is unblocked. If nothing was reported BLOCKED, skip straight to the next paragraph.

Now get task details and the pipeline args yourself with Bash, in this order, so both run after any stripping above and see a disproven task as runnable, using only commands that start with \`node\` (the skill's \`allowed-tools\` permits \`Bash(node *)\`, not compound shell commands like \`u=$(...)\`): first run \`node "${checkBlockersPath}" --unblocked '[1]'\` and read its output. If that output is non-empty, run \`node "${getTaskDetailsPath}" <output>\`, substituting the exact output text (the space-separated task numbers) in place of \`<output>\`. If that output is empty, skip that command and report "none of the requested tasks are unblocked" yourself instead. Then, regardless of the previous step, run \`node "${prepareTasksPath}" '[1]'\`.

Invoke \`/ponytail:ponytail ultra\`.

When \`[1]\` contains the word \`valid\`, the user has confirmed the tasks are still relevant — skip the **Verification** section below and treat every unblocked task in the details above as open and relevant.

## Verification

Review the task details above (each object comes from \`tasks.json\` if the task is open, or \`completedTasks.json\` if it was already completed). Cross-reference the task with the codebase to determine if the task is still relevant or if it has been resolved.
Use the git history and recent commits (over the last 3 days) to confirm/deny the existence of the unblocked tasks detailed above.

## Running the pipeline

Each phase is its own workflow, launched in order. Call Workflow with the
scriptPath and args given below, and wait for each to finish before starting
the next.

The "pipeline args" JSON printed above has these keys: \`repo\`,
\`typecheckCommand\`, \`groups\`, \`repositorySources\`, \`repositoryManifest\`,
\`runId\`, \`startTimestamp\`, \`mergeScript\`, \`stepOutputsFile\`, \`mergeCommand\`.
Every step below passes all of those keys through unchanged, plus the extra
keys named in that step.

\`prepareTasks.ts\` has already written that whole JSON to disk, so step 6 never
retypes it. \`mergeCommand\` is the finished command line; \`stepOutputsFile\` is
the one file step 6 writes.

**Step 1 — plan.** scriptPath \`${planWorkflowPath}\`,
args = the pipeline args JSON exactly as printed, no additions.
Returns \`{plans, planned, needsClarification, notRelevant}\`.

**Step 2 — verify.** scriptPath \`${verifyWorkflowPath}\`,
args = the pipeline args JSON plus one added key:
- \`planned\`: the \`planned\` array from step 1, verbatim.

Reviews each plan with codex (falls back to fable-medium, then opus 4.8-medium). On a rejection the verifier applies codex's
suggested fixes to the plan file and re-runs codex once; a second rejection is
final. Returns \`{verified, approved, rejected, revisedCount, reviewHandoffs}\`.
If \`approved\` is empty, stop and report — there is nothing to implement.
Report \`revisedCount\` so the user knows how many plan files codex rewrote.
\`reviewHandoffs\` is one string per verified task recording codex's verdict —
real evidence the approval gate later checks, carried into step 6.

**Step 3 — implement.** scriptPath \`${implementWorkflowPath}\`,
args = the pipeline args JSON plus one added key:
- \`approved\`: the \`approved\` array from step 2, verbatim.

Returns \`{results, done, partial, blocked, requeueCount}\`.

**Step 4 — test.** scriptPath \`${testWorkflowPath}\`,
args = the pipeline args JSON plus:
- \`done\`: the \`done\` array from step 3, verbatim.
- \`approved\`: the \`approved\` array from step 2, so a failing test goes back to
  the implementer with the plan it implemented rather than to a cold agent.
- \`maxRounds\` (optional): test-then-fix rounds before giving up, default 3.

Returns \`{tests, allPassed, testReceipts}\`. \`testReceipts\` is one
\`{groupId, status}\` record per group — real evidence the approval gate later
checks, carried into step 6.

**Step 5 — approval.** Present \`needsClarification\`, \`rejected\`, \`partial\`,
\`blocked\` and \`tests\` to the user, and ask every needsClarification question
with AskUserQuestion. **Do not launch the merge workflow until the user
approves the work.**

**Step 6 — merge.** This step is a script you run yourself, not a workflow.
Only after the user approved in step 5.

First, Write the earlier steps' return values verbatim to the \`stepOutputsFile\`
path from the pipeline args — copy them, compute nothing:

\`\`\`json
{
  "done": [], "partial": [], "blocked": [],
  "needsClarification": [], "requeueCount": 0,
  "testReceipts": [], "reviewHandoffs": []
}
\`\`\`

\`done\`/\`partial\`/\`blocked\`/\`requeueCount\` come from step 3,
\`needsClarification\` from step 1, \`testReceipts\` from step 4, \`reviewHandoffs\`
from step 2. \`runMergePhase.ts\` derives every count and every merge argument
from that file — see \`buildMergeOutcomes\` in \`scripts/runMergePhase.ts\`.

Then run the \`mergeCommand\` string from the pipeline args, exactly as printed.
It takes no arguments; do not append any.

It prints \`{status, result, failure}\`. \`status\` is \`"merged"\` or \`"blocked"\`
(the pass/fail rule lives in \`judgeMergeRun\` in \`scripts/runMergePhase.ts\`, not
here). On \`"merged"\` you are done — \`result\` is the merge result.

On \`"blocked"\`, launch the unblock workflow — scriptPath
\`${mergeWorkflowPath}\`, args = the
printed \`failure\` object plus \`approvedByUser: true\`, plus \`decisions\` if the
user answered a previous round's questions.

It returns \`{fixed, summary, blockers, decisions}\`. Do not diagnose or fix
conflicts yourself; that stays in the workflow.

- If \`fixed\` is \`true\`, run \`mergeCommand\` again, unchanged.
- **If \`decisions\` is non-empty, that is the one you must act on.** Each entry
  is a choice the subagent deliberately refused to make for the user —
  conflicting logic, a missing source branch, something destructive. Ask every
  entry with AskUserQuestion, then launch the unblock workflow again with the
  user's answers as \`decisions\`.
- \`blockers\` are non-decision failures. Report them; the merge is incomplete.

A merge that returns a non-empty \`decisions\` or \`blockers\` did not finish — do
not report it as merged, and do not invoke close-tasks for its tasks.

Present merged and conflicts to the user. ONLY after the user approves, invoke
close-tasks once for all merged tasks.

There is no serial fallback path. One task or ten, the same code path runs.

## Closing your tasks

Close every task that is not problematic and was completed successfully, rendering its \`tasks.json\` entry stale, with **one** invocation of the \`close-tasks\` skill for all of them. Its first argument must be a JSON array of the task numbers with no spaces — \`[268,270,281]\` — followed by your reasoning for the \`closureNote\`s, naming each task (\`#268 …, #270 …\`) when the reasons differ.

If the user requests adding tasks, invoke the \`create-task\` skill once per task — never edit \`tasks.json\` directly.

During implementation, you (the orchestrator) run typecheck only — no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + full suite + the repo's UI verification where relevant) still runs once inside \`close-tasks\`, after the user approves closing.

## Commit message

Finally, stage the changes made this session — which may span multiple git repos or submodules — in each affected repo, but do not commit in any of them. Then invoke the \`commit-message\` skill to generate a commit-message summary for each affected repo, and show the summaries to the user.
\`;

test("brief matches the complete expected output byte-for-byte", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.equal(brief, expectedBrief);
});

test("fails loudly with no arguments on stdin rather than emitting a brief that points nowhere", () => {
  assert.match(runScriptExpectingFailure(""), /no arguments on stdin/);
});
```

This mirrors `tests/reviewPlanBrief.test.ts`'s two-tier style: pure-function tests that call the
exported brief function directly with literal strings (no subprocess, deterministic regardless
of live `tasks.json` content), plus subprocess tests that run the actual script through
`execFileSync` with real stdin, the same shape as `reviewPlanBrief.test.ts`'s `runScript` and
`runExpectingFailure` helpers. The end-to-end test re-derives its expected value by calling
`checkBlockers.ts` itself (same technique as `tests/taskStatsBrief.test.ts` lines 7-10, which
re-derives `taskStats.ts`'s output rather than hardcoding it), so it stays valid regardless of
what task 1 currently is in `tasks.json` — it only requires that task 1 exists, which is already
true (verified: task 1 is real and unblocked in the live `tasks.json`). The new
`expectedBrief` snapshot test is a full-string `assert.equal`, not a substring check, so any
accidental change anywhere in the large template literal — a dropped escape, a wrong path, a
missing line — fails it; it is intentionally the strictest test in the file and stands in for
byte-for-byte verification of the generated brief.

The `expectedBrief` snapshot interpolates the same `fileURLToPath(new URL(...))` constants the
script itself uses, so it carries no hardcoded checkout path and stays valid wherever the repo
lives — this was a codex review fix, applied before implementation, along with wrapping the
copied body in `const brief = \`...\`; return brief;` as the task requires.

All seven tests were run against an equivalent script during planning (with hardcoded absolute
paths to this repo's real files, since the plan may not write real files) and passed:
```
✔ brief embeds the blocked-status line under the label
✔ brief substitutes the literal argument string for every $ARGUMENTS occurrence and leaves none literal
✔ brief resolves every CLAUDE_PLUGIN_ROOT placeholder to an absolute path
✔ brief keeps the pipeline and closing instructions verbatim
✔ running the script end to end embeds the live checkBlockers.ts output for the given arguments
✔ brief matches the complete expected output byte-for-byte
✔ fails loudly with no arguments on stdin rather than emitting a brief that points nowhere
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

## Edit 3 (replace file): `skills/tackle-tasks/SKILL.md`

Replace the entire 147-line file with exactly this 10-line content:

```
---
name: tackle-tasks
description: tackle open tasks found in tasks.json (completed tasks are archived in completedTasks.json)
argument-hint: "[N,N,...] [valid]"
allowed-tools: Bash(git add *), Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/tackleTasksBrief.ts" <<'TACKLETASKSEOF'
$ARGUMENTS
TACKLETASKSEOF`
```

This mirrors `skills/review-plan/SKILL.md`'s pattern as described in the brief: frontmatter
(lines 1-6, unchanged from the live file — `name`, `description`, `argument-hint`,
`allowed-tools`), a blank line, then a single `!` block that pipes `$ARGUMENTS` through a
single-quoted heredoc into `node "${CLAUDE_PLUGIN_ROOT}/scripts/tackleTasksBrief.ts"`. The
delimiter `TACKLETASKSEOF` is single-quoted for the same reason `reviewPlanBrief.ts`'s usage
message documents for `REVIEWPLANEOF` (visible at `scripts/reviewPlanBrief.ts` lines 126-128):
"so nothing is shell-expanded on the way in." A distinct delimiter name is used so it cannot
collide with the `BLOCKERREASONEOF` delimiter that appears inside the generated brief text
itself.

This exact 10-line content was executed during planning (piped through stdin exactly as the
harness would) and correctly produced the live file's blocked-status line, all pipeline
instructions, and the closing/commit-message sections with every substitution resolved and zero
`CLAUDE_PLUGIN_ROOT` or `$ARGUMENTS` remaining.

## Files needing no edit

- `scripts/taskStatsBrief.ts` — reference pattern only, not touched.
- `skills/task-stats/SKILL.md` — reference pattern only, not touched.
- `tests/taskStatsBrief.test.ts` — reference pattern only, not touched.
- `scripts/reviewPlanBrief.ts` — reference pattern only, not touched.
- `tests/reviewPlanBrief.test.ts` — reference pattern only, not touched.

None of these files reference `tackle-tasks` or are affected by this change; they exist in the
owned-files list purely so the implementer (and this plan) can read the pattern being mirrored.

## Order of operations

1. Create `scripts/tackleTasksBrief.ts` (Edit 1).
2. Create `tests/tackleTasksBrief.test.ts` (Edit 2).
3. Run `node --test tests/tackleTasksBrief.test.ts` — all 7 tests must pass before touching
   `SKILL.md`, since the SKILL.md replacement makes the skill body depend on the new script
   working correctly.
4. Replace `skills/tackle-tasks/SKILL.md` (Edit 3).
5. Run the full verification block below.

## Verification

Run these commands from the repo root (`/Users/matkatmusicllc/Programming/taskTools`) after all
three edits:

1. `node --test tests/tackleTasksBrief.test.ts`
   Expected: `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`.

2. `npm test`
   Expected: exit code 0, no new failures introduced (this repo's existing test suite, defined
   in `package.json` as `node --test "tests/**/*.test.ts"`).

3. `wc -l skills/tackle-tasks/SKILL.md`
   Expected: `10 skills/tackle-tasks/SKILL.md`.

4. `printf '[1] valid\n' | node scripts/tackleTasksBrief.ts | head -1`
   Expected: a line starting with `- blocked status: ` followed by whatever
   `node scripts/checkBlockers.ts "[1] valid"` currently reports for task 1 (task 1 exists and is
   real in the live `tasks.json`, confirmed during planning).

5. `! printf '[1] valid\n' | node scripts/tackleTasksBrief.ts | grep -q 'CLAUDE_PLUGIN_ROOT'`
   Expected: exit code `0` — the leading `!` negates `grep -q`'s exit status, so this command
   itself succeeds only when `CLAUDE_PLUGIN_ROOT` does not appear anywhere in the output (unlike
   `grep -c`, which prints `0` but exits `1` on no match — this form's exit code is the actual
   pass/fail signal).

6. `! printf '[1] valid\n' | node scripts/tackleTasksBrief.ts | grep -q '\$ARGUMENTS'`
   Expected: exit code `0`, for the same reason as step 5.

7. `git diff --stat skills/tackle-tasks/SKILL.md`
   Expected: shows the file shrinking from 147 to 10 lines (a `-147 +10`-shaped diffstat), not a
   near-total rewrite of unrelated content — confirming only the intended file changed shape.
