# Task 62: Convert COMMIT_MESSAGES.md into a skill so the staged diff is injected into its body at invocation time

## User request

rewrite COMMIT_MESSAGE.md into a skill so the git diff command result can be injected into the skill body, then make every place that references COMMIT_MESSAGE.md reference that skill instead.

Note the real filename is skills/tackle-tasks/COMMIT_MESSAGES.md, plural.

Turn that file into a proper skill so the staged diff arrives as injected content rather than as an instruction someone has to follow. A skill body supports `!`command`` injection, which the harness runs at invocation time, so the diff is fresh by construction instead of fresh by discipline. skills/create-task/SKILL.md already does exactly this on its first line with `!`node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"`` — copy that shape.

This is the structural version of task 61's fix. 61 corrects the wording so the subagent is told to run git itself; this task removes the possibility of getting it wrong. 61 lands first and this builds on it.

Work:

1. Create a new skill, suggested skills/commit-message/SKILL.md, with the usual name/description frontmatter, carrying over the existing rules: one message per affected repo, a single sentence of 40 words or less, a parent repo whose only change is a moved submodule pointer counts as affected and its message names the submodule and why, and the `Repo:` / `Message:` output format.

2. `!` injection is a single fixed command string and cannot loop over repositories, so the multi-repo case needs a helper script — suggested scripts/stagedDiffs.ts — that enumerates the root repo plus any submodule with a moved pointer and prints each one's staged diff using the existing pathspec excludes: git -C <repo> diff --staged -- ':(exclude)*tasks.json' ':(exclude)*completedTasks.json' ':(exclude)plans/archived'. The skill body injects that one script.

3. Repoint every reference and delete the old file. The three call sites are: skills/tackle-tasks/SKILL.md line 141, which currently injects `!`cat "${CLAUDE_PLUGIN_ROOT}/skills/tackle-tasks/COMMIT_MESSAGES.md"``; scripts/stage-and-summarize-stop.ts lines 35-44, which resolves the file path and emits additionalContext saying "read <path> and follow those directions" — a Stop hook cannot invoke a skill directly, so it must name the skill for the agent to invoke instead of naming a file to read; and skills/update-tasks/SKILL.md line 27, which task 61 will have pointed at COMMIT_MESSAGES.md.

4. Delete skills/tackle-tasks/COMMIT_MESSAGES.md once nothing references it. Confirm with a repo-wide search for COMMIT_MESSAGES that no reference survives.

skills/close-tasks/SKILL.md line 22 is out of scope: it emits a fixed "Closed tasks [...]" message and uses no subagent.

### skills/commit-message/SKILL.md

(missing: file not found on disk)

### skills/tackle-tasks/COMMIT_MESSAGES.md

```
If you made any changes to the codebase — which may span multiple git repos or submodules — stage the changes in each affected repo, but do not commit in any of them. Then generate one commit message per repo:

Use a single subagent running `Sonnet 5` (fall back to `Opus 5` if Sonnet is unavailable or errors): pass it the path of every repo or submodule in which the caller staged changes — not diff contents — and instruct it to run the collection itself, at the moment it starts: for each supplied repo path, run `git -C <repo> diff --staged -- ':(exclude)*tasks.json' ':(exclude)*completedTasks.json' ':(exclude)plans/archived'` immediately, treating a repo as affected only if that command produces a nonempty diff, and also run `git -C <repo> diff --staged --raw -- ':(exclude)*tasks.json' ':(exclude)*completedTasks.json' ':(exclude)plans/archived'` on each affected repo and treat any line whose old or new file mode is `160000` as a moved submodule pointer — and have it generate, per affected repo, a short (40 words or less) single-sentence summary of the work done in that repo, so the user can use each summary as that repo's commit message.
A parent repo whose only change is a submodule pointer counts as an affected repo — its message should name the submodule being updated and why.

Report the summaries to the user, one line per repo, in the following format:
```
Repo: <repo name> 
Message: <summary>
```

```

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

### skills/update-tasks/SKILL.md

```
---
name: update-tasks
description: scan plans/ implementation notes and handoffs for open items/questions, add them to tasks.json, then archive the notes into plans/archived/
allowed-tools: Bash(git add *)
---

First, invoke `/ponytail:ponytail ultra`.

Then:

1. Files to process: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/extractOpenSections.ts" --list`

2. Extracted open-work sections (every `### Open questions` section from implementation notes, the `## What Remains` section from handoffs; each under a `=== <file> ===` banner): 
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/extractOpenSections.ts"`


   Apply judgment to the extracted text above: skip items the section itself marks as resolved (e.g. "None blocking"), and skip empty sections.

3. **De-duplicate.** Before adding, check both `tasks.json` and `completedTasks.json` (titles and descriptions) for an existing task covering the same item. If an open item belongs to an existing open task, extend that task's `description` (and add the source file to its `handoffFilePaths`) instead of creating a duplicate.
Titles: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/getTaskDetails.ts"`

4. **Create each new task via the `create-task` skill** — one Skill-tool invocation per task, sequentially (each invocation injects the then-current next taskNumber). Pass as args: a short title, the open item in the source file's own wording (with enough context to act on it later — file paths, item numbers), and the source file's **archived** path (e.g. `plans/archived/implementation-notes-item66-fork-style-port.md`) to record as `handoffFilePaths`. The wording is already refined here — create-task should not need AskUserQuestion. If the Skill tool is unavailable, append directly to `tasks.json` in the same format instead (`taskNumber` = run `node "${CLAUDE_PLUGIN_ROOT}/scripts/nextTaskNumber.ts"` before each append, `title`, `description`, `handoffFilePaths`; omit completion-related fields).

5. **Archive the processed files**: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/archiveProcessed.ts" <the step-1 file list>`. It moves each given file into `plans/archived/` (a file that yielded no new tasks is still retired by processing it) and leaves any file in place whose name already exists in `plans/archived/`, printing `COLLISION` for it — report those collisions.

Finally, report a short table: each archived file → the task numbers created from it (or "none / duplicate of task N"). 
Stage the changes but do not commit. Follow `skills/tackle-tasks/COMMIT_MESSAGES.md` to generate a commit-message summary for each affected repo, and show the summaries to the user.

```

### scripts/stagedDiffs.ts

(missing: file not found on disk)

### scripts/stage-and-summarize-stop.ts

```
// Stop hook: reflow wrapped comments in this session's edited files, then flag any still-unstaged ones.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { emitReflows, reflowFile } from "./reflowComments.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
if (input.stop_hook_active) process.exit(0);
const sid = input.session_id;
if (typeof sid !== "string" || sid.length === 0) process.exit(0);

const flag = join(process.env.HOME ?? "", ".claude", "turn-flags", sid);
if (!existsSync(flag)) process.exit(0);
const paths = [...new Set(readFileSync(flag, "utf8").split("\n").filter(Boolean))];
rmSync(flag, { force: true }); // consumed: the reminder fires once per file-modifying stretch

const reflowed = paths.filter(existsSync).map((path) => ({ path, runs: reflowFile(path) }));

// Porcelain column two: space means staged, anything else means unstaged. Outside a repo, git throws — counts as clean.
const unstaged = paths.some((p) => {
  try {
    return execFileSync("git", ["-C", dirname(p), "status", "--porcelain", "--", p], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).split("\n").some((line) => line.length > 1 && line[1] !== " ");
  } catch {
    return false;
  }
});

// One JSON payload per invocation; the staging pointer waits for the next turn.
if (emitReflows("Stop", reflowed, sid)) process.exit(0);

if (!unstaged) process.exit(0);

const instructionsPath = resolve(
  import.meta.dirname, "..", "skills", "tackle-tasks", "COMMIT_MESSAGES.md",
);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "Stop",
    additionalContext:
      `Files were changed, read ${instructionsPath} and follow those directions.`,
  },
}));

```

### tests/commitMessageSubagent.test.ts

(missing: file not found on disk)
