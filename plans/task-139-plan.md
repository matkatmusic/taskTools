# Task 139 plan — tackle-tasks: orchestrator launches one task.workflow.js per task, no phase barriers

## Summary

`scripts/tackleTasksBrief.ts` currently tells the orchestrator to run four
phase workflows in sequence (`plan.workflow.js` → `verify.workflow.js` →
`implement.workflow.js` → `test.workflow.js`), each waiting for every task to
finish before the next starts, then an approval step, then a `merge.workflow.js`
step keyed on an aggregate `stepOutputsFile` and a `mergeCommand` string.

Replace that whole "## Running the pipeline" body with one instruction: launch
`task.workflow.js` once per task, as a background workflow, nothing waiting on
anything else, with args narrowed per launch to `{task, typecheckCommand}` —
the exact shape `task.workflow.js` itself reads (see edit 2's reason). Delete
the now-unused workflow-path constants for the four retired workflows and for
`merge.workflow.js`, add one constant for `task.workflow.js`, and remove every
mention of `stepOutputsFile` and `mergeCommand`. Do not write a replacement
for the approval gate or the merge tail — a later task in the 86 chain (split
3 of 3) covers that; this task covers "launch shape only" (split 1 of 3, per
brief-139's own scoping).

Delete the byte-for-byte pin test in `tests/tackleTasksBrief.test.ts` (the one
anchored at commit `57f3ae1`), along with the helper and constants that exist
only to serve it, since they become dead code once that test is gone.

`plans/task-86-spec.md` needs no edit — it is reference material only; the
task's `files` list includes it so its "Parallel phase" section (already
quoted in brief-139) is available to read, not to change.

## Edits

### 1. `scripts/tackleTasksBrief.ts` lines 10–16 — workflow path constants

Current text (lines 10–16):

```
const skillDir = new URL("../skills/tackle-tasks/", import.meta.url);
const blockersWorkflowPath = fileURLToPath(new URL("blockers.workflow.js", skillDir));
const planWorkflowPath = fileURLToPath(new URL("plan.workflow.js", skillDir));
const verifyWorkflowPath = fileURLToPath(new URL("verify.workflow.js", skillDir));
const implementWorkflowPath = fileURLToPath(new URL("implement.workflow.js", skillDir));
const testWorkflowPath = fileURLToPath(new URL("test.workflow.js", skillDir));
const mergeWorkflowPath = fileURLToPath(new URL("merge.workflow.js", skillDir));
```

Becomes:

```
const skillDir = new URL("../skills/tackle-tasks/", import.meta.url);
const blockersWorkflowPath = fileURLToPath(new URL("blockers.workflow.js", skillDir));
const taskWorkflowPath = fileURLToPath(new URL("task.workflow.js", skillDir));
```

Reason: `planWorkflowPath`, `verifyWorkflowPath`, `implementWorkflowPath`, and
`testWorkflowPath` are each referenced exactly once, inside the "Running the
pipeline" block being deleted in edit 2 below (`${planWorkflowPath}` at old
line 76, `${verifyWorkflowPath}` at old line 80, `${implementWorkflowPath}` at
old line 92, `${testWorkflowPath}` at old line 98). `mergeWorkflowPath` is
referenced exactly once, also inside that block (`${mergeWorkflowPath}` at old
line 141). Once that block is deleted, all five become unused declarations —
delete them here. `blockersWorkflowPath` and `skillDir` stay: `blockersWorkflowPath`
is used earlier in the brief body (the "Call Workflow with scriptPath
`${blockersWorkflowPath}`" sentence, outside the block being edited), and
`skillDir` is needed to build both `blockersWorkflowPath` and the new
`taskWorkflowPath`.

### 2. `scripts/tackleTasksBrief.ts` lines 60–162 — the "Running the pipeline" body

Current text (lines 60–162), i.e. everything from the `## Running the
pipeline` heading through the line `There is no serial fallback path. One
task or ten, the same code path runs.` inclusive:

```
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
```

Becomes:

```
## Running the pipeline

The "pipeline args" JSON printed above has these keys: \`repo\`,
\`typecheckCommand\`, \`groups\`, \`repositorySources\`, \`repositoryManifest\`,
\`runId\`, \`startTimestamp\`, \`mergeScript\`. \`groups\` has one entry per task,
and each entry's task number is at \`tasks[0].number\`.

Launch \`${taskWorkflowPath}\` once per entry in \`groups\`, as a **background**
workflow — the call returns immediately, so the orchestrator stays free to
launch the next task's workflow right away. Nothing waits on anything else.

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
```

Reason: this removes the four sequential phase-workflow steps and their
barriers ("wait for each to finish before starting the next"), the approval
step (Step 5) and the merge step (Step 6) along with every mention of
`stepOutputsFile` and `mergeCommand` (the aggregate keys tied to the
now-deleted batch merge model), and replaces them with a per-task launch
instruction narrowed to the one argument shape `task.workflow.js` actually
reads, plus the notification-based completion signal, matching
`plans/task-86-spec.md`'s "Parallel phase — no barriers" section ("Each
`task.workflow.js` is launched as a **background** workflow, so the call
returns immediately and its completion sends a task-notification back to the
orchestrator. That notification is how the orchestrator learns a task is
ready, with no polling"). No replacement text is written for what happens
after a task finishes (gate, merge) — that is `brief-139`'s explicit boundary
("a later task in this chain writes what runs after approval"; concurrency
policy and the approval gate are the other two children of this same split).

The narrowed `{task, typecheckCommand}` args object is read directly from
`skills/tackle-tasks/task.workflow.js` lines 1–6, which destructure only
`ARGS.task` (line 2: `const N = ARGS.task`), `ARGS.stage`,
`ARGS.typecheckCommand`, `ARGS.workerModel`, and `ARGS.maxRounds` — never
`groups`, `repo`, `repositorySources`, `repositoryManifest`, `runId`,
`startTimestamp`, or `mergeScript`. The rest of the task's data comes from
`loadPreparedTask()` (same file, `runPlan`/`runImplement`), which reads
`tasks.json` directly by task number. Passing the full aggregate pipeline-args
JSON unmodified to every launch, as an earlier draft of this plan did, would
leave `ARGS.task` `undefined` for every single launch, since none of the
top-level pipeline-args keys is named `task`. `groups` is already shaped for
this: `buildWorkflowArguments` in `scripts/prepareTasks.ts` (lines 156–183)
builds it via `tasks.map(...)`, one `PreparedGroup` per requested task, each
carrying that task's number at `tasks[0].number` — narrowing to `{task,
typecheckCommand}` per launch is reading that existing structure, not
inventing one. `mergeScript` stays in the top-of-section key list (only
`stepOutputsFile` and `mergeCommand` were named for removal); `groups` also
stays in that key list, since restructuring what `prepareTasks.ts` puts in
that key is not part of this task's file list — only how `tackleTasksBrief.ts`
reads one entry out of it, per launch, changes here.

The `## Closing your tasks` and `## Commit message` sections that follow (old
lines 164–175, unchanged, immediately after the blank line that follows this
block) need no edit — neither mentions `stepOutputsFile`, `mergeCommand`, or
any of the four retired workflow-path constants.

### 3. `tests/tackleTasksBrief.test.ts` lines 7–33 — delete the byte-for-byte pin and its private helpers

Current text (lines 7–33):

```
// The commit whose SKILL.md still carried the body inline — the source text this script copied.
const preRefactorCommit = "57f3ae1dc201ff311c9f540d6fd6b53bafc08424";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const scriptPath = fileURLToPath(new URL("../scripts/tackleTasksBrief.ts", import.meta.url));
const checkBlockersPath = fileURLToPath(new URL("../scripts/checkBlockers.ts", import.meta.url));

function preRefactorBody(): string {
  const skill = execFileSync("git", ["show", `${preRefactorCommit}:skills/tackle-tasks/SKILL.md`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return skill.split("\n").slice(7).join("\n");
}

test("brief reproduces the pre-refactor skill body byte-for-byte once its substitutions are applied", () => {
  const argsValue = "[75] valid";
  const blockedStatus = execFileSync("node", [checkBlockersPath, argsValue], { encoding: "utf8" }).trimEnd();
  const expected = preRefactorBody()
    .replace(
      '- blocked status: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/checkBlockers.ts" \'$ARGUMENTS\'`',
      `- blocked status: ${blockedStatus}`,
    )
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", repoRoot)
    .replaceAll("$ARGUMENTS", argsValue);
  assert.equal(tackleTasksBrief(argsValue, blockedStatus), expected);
});
```

Becomes:

```
const scriptPath = fileURLToPath(new URL("../scripts/tackleTasksBrief.ts", import.meta.url));
const checkBlockersPath = fileURLToPath(new URL("../scripts/checkBlockers.ts", import.meta.url));
```

Reason: brief-139 requires deleting the test at (old) line 22, the
byte-for-byte pin against commit `57f3ae1` — "it only ever proved the
SKILL.md-to-TypeScript extraction was lossless, and this task changes the
brief on purpose." `preRefactorCommit` (old line 8), `repoRoot` (old line 10),
and `preRefactorBody` (old lines 14–20) exist solely to build that one test's
`expected` value — `repoRoot` is not read anywhere else in the file, and
`preRefactorBody`/`preRefactorCommit` are not called or read anywhere else —
so deleting the test without deleting them would leave three unused
declarations. `scriptPath` and `checkBlockersPath` stay: both are read by the
three remaining tests ("script reads arguments from stdin…", "series adds the
serial-mode section…" reads neither directly but "script fails loudly…" reads
`scriptPath`, and "script reads arguments from stdin…" reads both).

Line 6 (blank, before old line 7) and line 34 (blank, after old line 33,
before the next test at old line 35) are untouched and continue to separate
this block from its neighbors — this edit's old_string starts at old line 7
and ends at old line 33, leaving both surrounding blank lines exactly where
they are.

No other lines in `tests/tackleTasksBrief.test.ts` change. The three
remaining tests (old lines 35–39, 41–46, 48–55) and the final test (old lines
57–59) are copied forward unchanged, becoming (after this deletion) the whole
of the file below the two retained `const` lines, in the same order,
separated by the same single blank lines that already exist between them in
the current file.

### 4. `tests/tackleTasksBrief.test.ts` — add a test for the new launch shape

Insert after line 59 (the closing `});` of the last existing test, "script
fails loudly rather than emitting a brief that points nowhere"), i.e. append
at the end of the file, preceded by one blank line exactly like the blank
lines already separating the other tests:

```

test("running the pipeline launches task.workflow.js once per task in the background, with no phase barriers", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /Launch `.*task\.workflow\.js` once per entry in `groups`, as a \*\*background\*\*/);
  assert.match(brief, /Args for each launch: `\{task, typecheckCommand\}`/);
  assert.match(brief, /task-notification back to you/);
  assert.doesNotMatch(brief, /wait for each to finish before starting/);
  assert.doesNotMatch(brief, /stepOutputsFile/);
  assert.doesNotMatch(brief, /mergeCommand/);
  assert.doesNotMatch(brief, /Step 1 — plan/);
});
```

Reason: brief-139's done-criteria require the four phase-workflow barriers,
`stepOutputsFile`, and `mergeCommand` to be gone from the brief, and require
the brief to launch one `task.workflow.js` per task as a background workflow
with no polling. Edit 2 above makes those changes to the generated string but
nothing in the existing four tests reads the "Running the pipeline" section's
content (confirmed in edit 3's reason above), so none of them would fail if
edit 2 were wrong or reverted. This test reads the actual generated brief
string and asserts: the new per-task background-launch sentence is present
with the `groups`-narrowing wording from edit 2, the narrowed `{task,
typecheckCommand}` args sentence is present, the task-notification sentence is
present, and none of the retired barrier language, `stepOutputsFile`, or
`mergeCommand` survive. The regexes match edit 2's "Becomes" text verbatim (up
to the parts of that text edit 2 itself describes as reasoning rather than
brief content), so this test passes once edit 2 is applied exactly as written
and fails if edit 2's wording changes or is only partially applied.

### `plans/task-86-spec.md`

No edit. It is in this task's `files` list only so brief-139 could quote its
"Parallel phase — no barriers" section inline (which it does, in full) — this
task's own description says the split covers that section "launch shape
only," and nothing in brief-139's done-criteria asks for a change to this
file. It is reference material for edits 1–3 above, not an edit target.

## Verification

Run from `/Users/matkatmusicllc/Programming/taskTools-86`:

1. `bun test tests/tackleTasksBrief.test.ts`
   Before this plan's edits: `5 pass, 0 fail` (confirmed by running it during
   planning).
   Expected after edits: `5 pass, 0 fail` — the byte-for-byte pin is gone, the
   other four original tests (placeholder-expansion, stdin-read,
   series-section, fail-loudly) are untouched and still pass because none of
   them assert anything about the "Running the pipeline" section's content,
   and the new test added in edit 4 passes against edit 2's new brief text.

2. `rg -n "stepOutputsFile|mergeCommand" scripts/tackleTasksBrief.ts`
   Expected: no output (exit code 1, no matches).

3. `rg -n "planWorkflowPath|verifyWorkflowPath|implementWorkflowPath|testWorkflowPath|mergeWorkflowPath" scripts/tackleTasksBrief.ts`
   Expected: no output — all five retired constants and their usages are gone.

4. `rg -n "taskWorkflowPath" scripts/tackleTasksBrief.ts`
   Expected: two matches — the `const taskWorkflowPath = ...` declaration and
   its one use inside the new "Running the pipeline" text
   (`` \`${taskWorkflowPath}\` ``).

5. `rg -n "preRefactorBody|preRefactorCommit|57f3ae1" tests/tackleTasksBrief.test.ts`
   Expected: no output — the pin, its commit constant, and its helper are all
   gone.

6. `rg -n "repoRoot" tests/tackleTasksBrief.test.ts`
   Expected: no output — `repoRoot` had no other reader.

7. `grep -c "^test(" tests/tackleTasksBrief.test.ts`
   Expected: `5` — the four original tests minus the deleted byte-for-byte pin,
   plus the new test added in edit 4.

8. `rg -n "taskWorkflowPath.*once per entry in .groups" scripts/tackleTasksBrief.ts`
   Expected: one match — the new per-task launch sentence from edit 2.
