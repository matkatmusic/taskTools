# Task 163 plan — orchestrator drives the merge scheduling queue and deletes the superseded workflow files

## Summary of the change

`scripts/tackleTasksBrief.ts` generates the orchestrator's instructions. Today
those instructions stop after saying an approved task "enters the merge
queue" and never launch anything, and they still tell the orchestrator to run
the `close-tasks` skill at the end. This plan:

1. Adds a new "## Merge queue" section to the generated brief that drives
   `scripts/runMergePhase.ts`'s exported queue functions with `node -e`
   commands, launching `skills/tackle-tasks/task.workflow.js` at stage
   `rebase-test` then `merge` for whichever task the queue says is next, one
   at a time.
2. Threads an explicit `workflowOutstanding` boolean into `shouldEndQueue`,
   so a zero-merge lap only ends the queue when no task workflow is still
   running or awaiting its gate.
3. Rewrites the "## Closing your tasks" section so it no longer invokes the
   `close-tasks` skill — closing now happens inside the merge stage via
   `scripts/closeTasks.ts` (task 152) — while retiring the old paragraphs as
   a `// RETIRED (task 163): ...` comment instead of deleting them outright.
4. Deletes the five superseded workflow files (`merge.workflow.js`,
   `plan.workflow.js`, `implement.workflow.js`, `test.workflow.js`,
   `verify.workflow.js`) — confirmed today, by `git grep`, to have zero
   referrers anywhere in the repository outside `plans/` and
   `.taskTools/` (historical task text and archived task records).
5. Updates `plans/task-86-spec.md` to mark the chain closed and the two
   Risks/open-items bullets that reference the now-deleted files as done.
6. Adds tests to `tests/tackleTasksBrief.test.ts` (generated-instruction
   assertions + file-removal assertion) and `tests/runMergePhase.test.ts`
   (one real, end-to-end worktree driven through the queue).

## File-by-file edits

### 1. `scripts/tackleTasksBrief.ts`

**Edit 1.1 — add the `runMergePhase.ts` path constant.**

Current text (lines 12–13):
```
const blockersWorkflowPath = fileURLToPath(new URL("blockers.workflow.js", skillDir));
const taskWorkflowPath = fileURLToPath(new URL("task.workflow.js", skillDir));
```
Becomes:
```
const blockersWorkflowPath = fileURLToPath(new URL("blockers.workflow.js", skillDir));
const taskWorkflowPath = fileURLToPath(new URL("task.workflow.js", skillDir));
const runMergePhaseUrl = new URL("./runMergePhase.ts", import.meta.url).href;
```
`runMergePhaseUrl` is a module URL (`.href`), not a filesystem path — it is
substituted into an `import(...)` string literal below, so it must be a
valid JavaScript string when inserted via `JSON.stringify`.

**Edit 1.2 — insert the "## Merge queue" section, and rewrite "## Closing your
tasks", leaving the "## Gate each task" ending paragraph untouched.**

Current text (lines 111–126, exact, including the escaped backticks as they
appear in the file):
```
Only "Approve for merge" clears a task to merge; "Do not approve" means
the task never enters the merge queue and never merges. An approved task
enters the merge queue immediately on approval — even while other tasks
are still planning or implementing. Never hold an approved task back to
gate or merge it alongside the rest, and never let this gate become a
barrier that waits for the whole batch.

## Closing your tasks

Close every task that is not problematic and was completed successfully, rendering its \`tasks.json\` entry stale, with **one** invocation of the \`close-tasks\` skill for all of them. Its first argument must be a JSON array of the task numbers with no spaces — \`[268,270,281]\` — followed by your reasoning for the \`closureNote\`s, naming each task (\`#268 …, #270 …\`) when the reasons differ.

If the user requests adding tasks, invoke the \`create-task\` skill once per task — never edit \`tasks.json\` directly.

During implementation, you (the orchestrator) run typecheck only — no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + full suite + the repo's UI verification where relevant) still runs once inside \`close-tasks\`, after the user approves closing.

## Commit message
```

Becomes (note: the "Only \"Approve for merge\" ... barrier that waits for the
whole batch." paragraph is reproduced byte-for-byte unchanged — nothing in it
is retired, since nothing is removed from it, only appended after it):
```
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
- Step: \`FN\` = \`nextQueueStep\`, \`ARGS\` = \`<QUEUE_JSON>\`.
- Outcome: \`FN\` = \`recordStageOutcome\`, \`ARGS\` = \`<QUEUE_JSON>, taskNumber, "stage", outcome\` (\`outcome\` is \`{"status":"success"}\` or \`{"status":"failure","reason":lastFailure}\`). Record the printed JSON as the new \`queue\`.
- Merged-not-closed: \`FN\` = \`recordMergedNotClosed\`, \`ARGS\` = \`<QUEUE_JSON>, taskNumber, mergedCommitHash, closeError\`. Record the printed JSON as the new \`queue\`.
- End check: \`FN\` = \`shouldEndQueue\`, \`ARGS\` = \`<QUEUE_JSON>, workflowOutstanding\`.
- Next lap: \`FN\` = \`beginNextLap\`, \`ARGS\` = \`<QUEUE_JSON>\`. Record the printed JSON as the new \`queue\`.
- Report: \`FN\` = \`buildMergeReport\`, \`ARGS\` = \`<QUEUE_JSON>\`.

Track \`outstandingEntries\`, a map from task number to \`"plan+implement"\`, \`"rebase-test"\`, or \`"merge"\`, naming the workflow you currently have launched for that task and awaiting a result on. Add an entry the moment you launch that task's \`plan+implement\` workflow (before this section — task planning and implementing happens outside the merge queue proper, but its notification still gates when the queue may end). Add an entry when you launch a \`rebase-test\` or \`merge\` workflow, per step 1 below. Remove a task's entry only in these two cases:
- Its \`plan+implement\` completion notification arrives: immediately ask that task's own approval gate (per "## Gate each task" above), before doing anything else in this section. On "Approve for merge", run \`enqueueApprovedTask(queue, taskNumber)\` and record the printed JSON as the new \`queue\`, then remove the entry. On "Do not approve", remove the entry without enqueueing.
- Its \`rebase-test\` or \`merge\` completion notification arrives and step 2 below has recorded the outcome: remove the entry.

\`workflowOutstanding\`, passed to \`shouldEndQueue\`, is \`outstandingEntries.size > 0\`. After every enqueue and every completion notification, repeat:

1. Run \`nextQueueStep(queue)\`. If it prints \`null\`, skip to step 3. If it prints a step \`{taskNumber, stage}\`: if any task's entry in \`outstandingEntries\` is \`"rebase-test"\` or \`"merge"\`, a rebase-test or merge workflow you launched is still outstanding — do not launch anything; wait for that workflow's completion notification, then go back to step 1. Otherwise, launch \`${taskWorkflowPath}\` as a background workflow with args \`{task: taskNumber, stage, repositoryManifest}\` — \`repositoryManifest\` is the pipeline args value from above — add \`taskNumber → stage\` to \`outstandingEntries\`, and go back to step 1. Merging stays serial: never launch a second rebase-test or merge workflow while one is still outstanding, because every merge moves the tip the next task rebases onto.
2. When a launched rebase-test or merge workflow's completion notification arrives, read its result's \`status\` (\`green\` is success for \`rebase-test\`; \`merged\` or \`merged-but-not-closed\` is success for \`merge\`; anything else is a failure, with \`lastFailure\` naming why). Run \`recordStageOutcome(queue, taskNumber, stage, outcome)\` — \`outcome\` is \`{"status":"success"}\` or \`{"status":"failure","reason":lastFailure}\` — and record the printed JSON as the new \`queue\`. If the merge stage reported \`merged-but-not-closed\`, also run \`recordMergedNotClosed(queue, taskNumber, mergedCommitHash, closeError)\` and record that printed JSON as the new \`queue\`. Remove that task's entry from \`outstandingEntries\`. Then go back to step 1.
3. Run \`shouldEndQueue(queue, workflowOutstanding)\`. If it prints \`true\`, the queue is done: run \`buildMergeReport(queue)\` and report its \`unmerged\` and \`mergedNotClosed\` entries to the user. If it prints \`false\` and \`queue\`'s \`carryover\` is non-empty, run \`beginNextLap(queue)\`, record the printed JSON as the new \`queue\`, and go back to step 1. If it prints \`false\` and \`carryover\` is empty, a task is still planning, implementing, or waiting on its own gate — wait for the next enqueue or completion notification, then go back to step 1.

## Closing your tasks

Closing each merged task happens automatically: \`${taskWorkflowPath}\`'s merge stage calls scripts/closeTasks.ts directly once that task's own merge has succeeded, hash-gated so a task is archived only against the commit it actually merged into. You never invoke a skill to close a task, and \`buildMergeReport\`'s \`mergedNotClosed\` entries name every task that merged but failed to archive, so you can follow up.

If the user requests adding tasks, invoke the \`create-task\` skill once per task — never edit \`tasks.json\` directly.

During implementation, you (the orchestrator) run typecheck only — no test suites or visual checks. Workers run the tests covering the files they own and fix their own failures before reporting status complete; a worker with failing tests reports blocked or partial, never complete. Full verification (typecheck + each layer's complete test suite) runs once per task, inside that task's own rebase-test stage, before it can reach the merge queue's merge stage.

## Commit message
```

**Edit 1.3 — retire the two superseded "## Closing your tasks" paragraphs as
a comment**, so they are not deleted outright. Insert this block immediately
after the `tackleTasksBrief` function's closing `};` (current line 131,
`};`), before the blank line that precedes `function readStdin(): string {`.
The retired paragraphs, verbatim, are the "Close every task..." and "During
implementation..." paragraphs quoted in full in Edit 1.2's "Current text"
block above — reproduce those two paragraphs verbatim as the body of this
comment, each of their lines prefixed with `// `:

```
// RETIRED (task 163): superseded by task 152's closeTasks.ts call in the merge stage; kept for reference.
//
// [the "Close every task..." paragraph, verbatim, from Edit 1.2's "Current text" above; prefix each line "// "]
//
// [the "During implementation..." paragraph, verbatim, from Edit 1.2's "Current text" above; prefix each line "// "]
```

No other edits to this file. `readStdin`, `fail`, and the CLI entrypoint at
the bottom (lines 133–155 today) are untouched.

### 2. `tests/tackleTasksBrief.test.ts`

Add two new imports at the top, alongside the existing ones (current lines
1–6):
```
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tackleTasksBrief } from "../scripts/tackleTasksBrief.ts";
import { TASKS_PER_COMMAND } from "../scripts/taskStats.ts";
```
(only `existsSync` and `join` are new; the rest already exist).

Append two new tests at the end of the file, after the existing "gate" test
(current lines 50–64):

```ts
test("merge queue: an approved task launches rebase-test then merge, and the brief never mentions the close-tasks skill", () => {
  const brief = tackleTasksBrief("[1]", "task 1: unblocked");
  assert.match(brief, /## Merge queue/);
  assert.match(brief, /node --input-type=module <<'TASK_TOOLS_QUEUE'/);
  assert.doesNotMatch(brief, /node -e "/);
  assert.match(brief, /createMergeQueue/);
  assert.match(brief, /enqueueApprovedTask\(queue, taskNumber\)/);
  assert.match(brief, /nextQueueStep\(queue\)/);
  assert.match(brief, /launch `.*task\.workflow\.js` as a background workflow with args `\{task: taskNumber, stage, repositoryManifest\}`/);
  assert.match(brief, /rebase-test.*or merge workflow.*outstanding/s);
  assert.match(brief, /recordStageOutcome\(queue, taskNumber, stage, outcome\)/);
  assert.match(brief, /shouldEndQueue\(queue, workflowOutstanding\)/);
  assert.match(brief, /buildMergeReport\(queue\)/);
  assert.match(brief, /outstandingEntries/);
  assert.match(brief, /immediately ask that task's own approval gate/);
  assert.match(brief, /do not launch anything.*wait for that workflow's completion notification/s);
  assert.doesNotMatch(brief, /close-tasks/);
});

test("the superseded workflow files are deleted and nothing outside plans/ or .taskTools/ imports them", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const superseded = [
    "skills/tackle-tasks/merge.workflow.js",
    "skills/tackle-tasks/plan.workflow.js",
    "skills/tackle-tasks/implement.workflow.js",
    "skills/tackle-tasks/test.workflow.js",
    "skills/tackle-tasks/verify.workflow.js",
  ];
  for (const relativePath of superseded) {
    assert.equal(existsSync(join(repoRoot, relativePath)), false, `${relativePath} should have been deleted`);
  }
  let matches = "";
  try {
    matches = execFileSync(
      "git",
      ["grep", "-l", "-e", "merge.workflow.js", "-e", "plan.workflow.js", "-e", "implement.workflow.js", "-e", "test.workflow.js", "-e", "verify.workflow.js", "--", ".", ":!plans", ":!.taskTools", ":!tests/tackleTasksBrief.test.ts"],
      { encoding: "utf8", cwd: repoRoot },
    );
  } catch (error) {
    const failure = error as { status?: number };
    if (failure.status !== 1) throw error;
  }
  assert.equal(matches.trim(), "");
});
```

`git grep` exits `1` (throwing in `execFileSync`) when it finds no matches;
that is the success path here, so the `catch` re-throws only on any other
exit status. The pathspecs exclude `plans/` (brief and plan prose that names
these files historically), `.taskTools/` (archived task records that
describe past work), and this test file itself (whose own source lists the
five filenames as plain strings).

### 3. `tests/runMergePhase.test.ts`

Add these imports at the top of the file, alongside the existing ones
(current lines 1–4):
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { compileFunction, constants as vmConstants } from "node:vm";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/repositoryManifest.ts";
import { beginNextLap, buildMergeReport, createMergeQueue, currentLapIsComplete, enqueueApprovedTask, hasLapRemaining, judgeMergeRun, MAX_LAPS, nextQueueStep, recordMergedNotClosed, recordStageOutcome, shouldEndQueue } from "../scripts/runMergePhase.ts";
```
(only the `node:child_process`, `node:fs`, `node:os`, `node:path`,
`node:crypto`, `node:vm`, and `../scripts/repositoryManifest.ts` imports are
new; the `node:test`, `node:assert/strict`, and `../scripts/runMergePhase.ts`
imports already exist and are unchanged).

Append the following helpers and one end-to-end test at the end of the file,
after the last existing test (current lines 157–171, the
`test_buildMergeReportReportsMergedNotClosedAsItsOwnOutcomeWithTheCommitHash`
test):

```ts
const REPO_ROOT = process.cwd();
const TASK_WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT, "skills/tackle-tasks/task.workflow.js"), "utf8")
    .replace("export const meta", "const meta");

type TaskWorkflowResult = { task: number; stage: string; results: Array<Record<string, unknown>> };
type TaskWorkflowRunner = (argsJson: string, log: (...values: unknown[]) => void, agent: (...values: unknown[]) => Promise<unknown>) => Promise<TaskWorkflowResult>;

const throwingAgent = async () => { throw new Error("end-to-end merge queue lap must not call an agent"); };

// Mirrors runMergeStage in tests/taskWorkflowMergeStage.test.ts, driving the same task.workflow.js source.
const runTaskWorkflowStage = async (worktreePath: string, args: Record<string, unknown>) => {
    const fn = compileFunction(
        `return (async () => { 'use strict'\n${TASK_WORKFLOW_SOURCE} })()`,
        ["args", "log", "agent"],
        { filename: join(worktreePath, "task.workflow.js"), importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    ) as TaskWorkflowRunner;
    const previousCwd = process.cwd();
    process.chdir(worktreePath);
    try {
        return await fn(JSON.stringify(args), () => {}, throwingAgent);
    } finally {
        process.chdir(previousCwd);
    }
};

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

// Mirrors makeRootWithWorktree in tests/taskWorkflowMergeStage.test.ts, plus seedTaskFiles/seedWorktreeTaskFile.
const makeQueueFixtureRepo = (taskNumber: number) => {
    const root = mkdtempSync(join(tmpdir(), "run-merge-phase-e2e-root-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "README.md"), "root\n");
    git(root, "add", "README.md");
    git(root, "commit", "-q", "-m", "init");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "-m", "add test script");
    const sourceBranch = "main";
    const baseOid = git(root, "rev-parse", sourceBranch);
    const operationBranch = `task-${taskNumber}`;
    const worktreePath = join(tmpdir(), `run-merge-phase-e2e-wt-${randomUUID()}`);
    git(root, "worktree", "add", "-q", "-b", operationBranch, worktreePath, sourceBranch);
    mkdirSync(join(worktreePath, "plans"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "scripts"), join(worktreePath, "scripts"));
    mkdirSync(join(root, ".taskTools"), { recursive: true });
    writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");
    mkdirSync(join(worktreePath, ".taskTools"), { recursive: true });
    writeFileSync(join(worktreePath, ".taskTools", "tasks.json"), JSON.stringify([{ taskNumber, title: "fixture", files: [], blockedBy: [] }]));
    const repositoryManifest: RepositoryManifest = {
        version: REPOSITORY_MANIFEST_VERSION,
        occurrences: [{
            occurrenceId: "",
            checkoutPath: root,
            parentOccurrenceId: null,
            pathInParent: null,
            gitlinkOid: null,
            depth: 0,
            originUrl: "",
            baseBranch: sourceBranch,
            baseOid,
            operationBranch,
            childOccurrenceIds: [],
            testState: "untested",
        }],
    };
    return { root, worktreePath, repositoryManifest };
};

test("test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged", async () => {
    const taskNumber = 9101;
    const { root, worktreePath, repositoryManifest } = makeQueueFixtureRepo(taskNumber);
    try {
        writeFileSync(join(worktreePath, "taskfile.txt"), "task change\n");
        git(worktreePath, "add", "taskfile.txt");
        git(worktreePath, "commit", "-q", "-m", "task change");

        let queue = createMergeQueue();
        queue = enqueueApprovedTask(queue, taskNumber);

        let step = nextQueueStep(queue);
        assert.deepEqual(step, { taskNumber, stage: "rebase-test" });
        const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest });
        const rebaseTestOutcome = rebaseTestResult.results[0] as { status: string };
        assert.equal(rebaseTestOutcome.status, "green");
        queue = recordStageOutcome(queue, taskNumber, "rebase-test", { status: "success" });

        step = nextQueueStep(queue);
        assert.deepEqual(step, { taskNumber, stage: "merge" });
        const mergeResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "merge", repositoryManifest });
        const mergeOutcome = mergeResult.results[0] as { status: string };
        assert.equal(mergeOutcome.status, "merged");
        queue = recordStageOutcome(queue, taskNumber, "merge", { status: "success" });

        assert.deepEqual(queue.merged, [taskNumber]);
        assert.equal(nextQueueStep(queue), null);
        assert.equal(shouldEndQueue(queue, false), true);
        assert.deepEqual(buildMergeReport(queue), { unmerged: [], mergedNotClosed: [] });

        const archived = JSON.parse(readFileSync(join(root, ".taskTools", "completedTasks.json"), "utf8"));
        assert.deepEqual(archived.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber]);
    } finally {
        rmSync(worktreePath, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
    }
});
```

`existsSync` is imported for parity with the pattern in
`tests/taskWorkflowMergeStage.test.ts` even though this one test does not
call it directly; no dead-import lint runs in this repo's `npm test`, and
leaving it out is fine too — either is correct, this plan includes it only
because it is copied from the read-only reference file's import list.
(If a linter is later added that flags unused imports, drop `existsSync`
from this file's import line — that is a deletion of an unused import, not
a change to this task's behavior.)

### 4. `plans/task-86-spec.md`

**Edit 4.1** — current text (lines 1–5):
```
# Task 86 — one worktree per task

Agreed design, from the grilling session on 2026-08-07. Supersedes the approach
described in the task 86 record (whose SKILL.md line references are stale — the
pipeline text moved to `scripts/tackleTasksBrief.ts`).
```
Becomes:
```
# Task 86 — one worktree per task

**Status: complete.** Task 163 closed this chain — the serial tail launches from the orchestrator's generated instructions and the superseded `*.workflow.js` files are deleted.

Agreed design, from the grilling session on 2026-08-07. Supersedes the approach
described in the task 86 record (whose SKILL.md line references are stale — the
pipeline text moved to `scripts/tackleTasksBrief.ts`).
```

**Edit 4.2** — current text (lines 264–271, in "## Risks and open items"):
```
- `merge.workflow.js` — today the "unblock" workflow launched on a blocked
  merge. Decided: whatever remains useful in its conflict-fixing prompt is
  folded into the `rebase-test` stage. Deleting it, and the other superseded
  `*.workflow.js` files, happens at the **end of the chain**, not in the task
  that supersedes each one.
- `blockers.workflow.js` — assumed unchanged, still runs before task prep.
- `test.workflow.js` disappears as a separate phase; its work splits between
  the implementer's own tests and the tail's full-suite gate.
```
Becomes:
```
- `merge.workflow.js` — was the "unblock" workflow launched on a blocked
  merge. Whatever remained useful in its conflict-fixing prompt was folded
  into the `rebase-test` stage (task 145). Task 163, the end of the chain,
  deleted it along with the other superseded `*.workflow.js` files.
- `blockers.workflow.js` — assumed unchanged, still runs before task prep.
- `test.workflow.js` disappeared as a separate phase; its work split between
  the implementer's own tests and the tail's full-suite gate. Task 163
  deleted it.
```

No other edits to this file — the "Bug found while grilling" section at the
bottom (lines 275–291) is left as-is: it is a historical note about task 156
that this task does not touch.

### 5. Delete the five superseded workflow files

Run:
```
git rm skills/tackle-tasks/merge.workflow.js
git rm skills/tackle-tasks/plan.workflow.js
git rm skills/tackle-tasks/implement.workflow.js
git rm skills/tackle-tasks/test.workflow.js
git rm skills/tackle-tasks/verify.workflow.js
```

This has already been confirmed safe: `git grep -l -e "merge.workflow.js" -e
"plan.workflow.js" -e "implement.workflow.js" -e "test.workflow.js" -e
"verify.workflow.js" -- . ":!plans" ":!.taskTools"` returns no matches today
— no production file, script, or workflow file references any of the five.

### 6. Files needing no edit

- `skills/tackle-tasks/task.workflow.js` — read-only, per the brief. Its
  `stage` argument handling (`rebase-test` and `merge` in `STAGE_RUNNERS`)
  already matches what the new brief text launches; nothing in it changes.
- `scripts/mergeTaskWorktrees.ts` — read-only, per the brief. Read for
  `mergeTaskDeepestFirst`'s return shape (`status: "merged"` /
  `"submodule-conflicted"` / `"parent-conflicted"`) used by the new
  end-to-end test's assertions; nothing in it changes.
- `scripts/runMergePhase.ts` — read-only, per the brief. Its queue exports
  (`createMergeQueue`, `enqueueApprovedTask`, `nextQueueStep`,
  `recordStageOutcome`, `shouldEndQueue`, `beginNextLap`,
  `recordMergedNotClosed`, `buildMergeReport`) are consumed exactly as
  written; nothing in it changes.
- `tests/taskWorkflowMergeStage.test.ts` — read-only, per the brief; its
  fixture pattern is reused (duplicated, not imported — its helpers are
  private `const`s, not exports) inside `tests/runMergePhase.test.ts`. No
  cases are added to or moved out of this file.

## Verification

Run, from the repo root:

```
npx tsc --noEmit
```
Expected: no errors.

```
npm test
```
Expected: all tests pass, including the two new tests in
`tests/tackleTasksBrief.test.ts` and the new end-to-end test in
`tests/runMergePhase.test.ts`, and every pre-existing test in both files
(the old "gate" assertions on lines 61–63 of `tests/tackleTasksBrief.test.ts`
still match, since that paragraph's text is unchanged) still passes.

```
git grep -l -e "merge.workflow.js" -e "plan.workflow.js" -e "implement.workflow.js" -e "test.workflow.js" -e "verify.workflow.js" -- . ":!plans" ":!.taskTools"
```
Expected: no output (exit code 1) — confirms nothing still references the
deleted files.

```
ls skills/tackle-tasks/
```
Expected: `blockers.workflow.js`, `task.workflow.js`, and `SKILL.md` (or
whatever non-`.workflow.js` files already live there) — the five superseded
`*.workflow.js` files are gone.
