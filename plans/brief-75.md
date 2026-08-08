# Task 75: Move the tackle-tasks skill body into a script that emits it as a literal brief, mirroring review-plan

## User request

convert 'tackle-tasks' skill body into a script, just like the skill body
  of 'review-plan'.  Keep it simple for now, just copy the task body directly into a
  'const brief = ' object that gets returned.  refactoring the skill body to be like
  'review-plan's skill body with logical code being used to dynamically generate the
  skill body is a separate task.

Fifth and by far the largest in the family with open tasks #71 (close-tasks), #72 (create-task), #73 (merge-worktree-tasks) and #74 (pick-a-task). Same pattern, same constraints, different source file. Do not merge them.

Pattern to copy — skills/review-plan/SKILL.md is 12 lines: frontmatter then a single `!` block (lines 7-11) piping $ARGUMENTS on stdin through a single-quoted heredoc into `node "${CLAUDE_PLUGIN_ROOT}/scripts/reviewPlanBrief.ts"`. The prose lives in scripts/reviewPlanBrief.ts as the exported template literal `reviewerBrief` (lines 39-113); the CLI entry at 132-139 writes it to stdout, guarded by `process.argv[1]?.endsWith("reviewPlanBrief.ts")` so the module stays importable by its test. Mirror its stdin read (readStdin, lines 115-121) and its loud failure path (fail, 124-130).

Current state — skills/tackle-tasks/SKILL.md is 142 lines, roughly five times the size of any sibling in this family. Frontmatter 1-6 (name, description, `argument-hint: "[N,N,...] [valid]"`, `allowed-tools: Bash(git add *), Bash(node *)`), body 8-141.

Four shell substitutions the script must handle:
1. Line 8 — `node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" '$ARGUMENTS'`
2. Line 9 — a compound shell one-liner: `u=$(node .../checkBlockers.ts --unblocked '$ARGUMENTS'); [ -n "$u" ] && node .../getTaskDetails.ts "$u" || echo "none of the requested tasks are unblocked"`. Decision taken: shell out verbatim rather than reimplementing the conditional in JS — run that exact string through a shell so behaviour is provably identical. This is a deliberate exception to the approach used elsewhere in the family; the quoting hazards are accepted in exchange for not re-deriving the fallback logic.
3. Line 10 — `node "${CLAUDE_PLUGIN_ROOT}/scripts/prepareTasks.ts" '$ARGUMENTS'`
4. Line 141 — `cat "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/COMMIT_MESSAGES.md"`. Keep this a runtime file read, not a hard-coded copy.

`$ARGUMENTS` also appears in prose at line 18 (the `valid` keyword rule), independent of the three shell uses. Use review-plan's single-quoted heredoc delimiter so nothing is shell-expanded on the way in.

The rest is a verbatim copy into one `const brief` template literal: invocation format (12), the BLOCKED refusal (14), the `/ponytail:ponytail ultra` invocation (16), the `valid` shortcut (18), `## Verification` (20-23), `## Running the pipeline` (25-127) covering the pipeline-args key list, Steps 1 through 6, the merge/unblock loop and the no-serial-fallback line, `## Closing your tasks` (129-135), and `## Commit message` (137-141). No logic may be introduced to generate any of that prose; deriving the body dynamically is explicitly a later, separate task.

Why this one is riskier than its siblings:
- `${CLAUDE_PLUGIN_ROOT}` appears roughly ten times, and five of those — lines 41, 45, 57, 63 and 106 — are `scriptPath` values (plan/verify/implement/test/merge .workflow.js) that the reading agent passes straight to the Workflow tool. A placeholder that fails to resolve breaks the entire pipeline, not just a sentence. Inside a JS template literal `${...}` is interpolation, not literal text, and the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand regardless. reviewPlanBrief.ts solved this at lines 6-7 with `fileURLToPath(new URL("./planReviewRuling.ts", import.meta.url))` and the comment "Absolute, because the reviewer's shell has no CLAUDE_PLUGIN_ROOT to expand". Apply that to every occurrence.
- Lines 85-91 are a fenced ```json block whose content is a brace-heavy object literal; lines 27-127 are dense with backticks around key names. All of it needs escaping inside a template literal, which is exactly what the byte-for-byte snapshot test exists to catch.

Ordering — two open tasks also edit skills/tackle-tasks/SKILL.md and must land first, or their edits will target a body that has since moved into the script: #62 converts COMMIT_MESSAGES.md into an invocation-time skill, which rewrites lines 137-141 (the `cat` substitution above); #70 adds the blockedBy-reason investigation step to the preamble at lines 8-14. Note #70 is itself blocked by #69 and #64, so this is a long chain.

### scripts/tackleTasksBrief.ts

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

```

### tests/tackleTasksBrief.test.ts

(missing: file not found on disk)

### scripts/taskStatsBrief.ts

```
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Absolute, because the reading agent's shell has no CLAUDE_PLUGIN_ROOT to expand
const taskStatsPath = fileURLToPath(new URL("./taskStats.ts", import.meta.url));

const stats = execFileSync("node", [taskStatsPath], { encoding: "utf8" }).trimEnd();

export const brief = `- stats: ${stats}

Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question.
`;

if (process.argv[1]?.endsWith("taskStatsBrief.ts")) {
  process.stdout.write(brief);
}

```

### skills/task-stats/SKILL.md

```
---
name: task-stats
description: report counts over tasks.json and completedTasks.json — open vs blocked, files coverage, closure velocity, and the group count a tackle-tasks run would produce
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/taskStatsBrief.ts"`

```

### tests/taskStatsBrief.test.ts

```
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { brief } from "../scripts/taskStatsBrief.ts";

test("brief embeds live taskStats.ts output under the stats label", () => {
  const taskStatsPath = fileURLToPath(new URL("../scripts/taskStats.ts", import.meta.url));
  const stats = execFileSync("node", [taskStatsPath], { encoding: "utf8" }).trimEnd();
  assert.ok(brief.includes(`- stats: ${stats}`));
});

test("brief keeps the verbatim print instruction", () => {
  assert.ok(
    brief.includes(
      "Print the block above to the user verbatim. Compute nothing, read no other file, add no commentary unless the user asks a follow-up question."
    )
  );
});

```
