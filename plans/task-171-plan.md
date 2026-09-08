# Task 171 plan: name the real results[] members in the generated driver text

## Root cause

`task.workflow.js` always returns `{ task, stage, results }` (confirmed at
`skills/tackle-tasks/task.workflow.js:736`: `return { task: N, stage: STAGE,
results: await runner() }`). `results` is an array:

- `rebase-test` stage → `results` has one entry, from `runRebaseTest()`
  (e.g. line 661: `return { stage: 'rebase-test', task: N, status: 'green',
  fenceViolations }`, or the `blocked` returns at lines 618/625/635/643/649/658
  which add `lastFailure`).
- `merge` stage → `results` has one entry, from `runMerge()` (success case at
  line 718: `return { stage: 'merge', task: N, failedAtStage, ...report,
  mergedCommitHash, closed: closeResult.closed, unblocked:
  closeResult.unblocked }`; the `merged-but-not-closed` case at line 707/710
  adds `closeError`).
- `plan+implement` stage → `results[0]` is the plan result from `runPlan()`
  (returns `{ stage: 'plan', task, status, planFile, question, files,
  verify, reviewRounds }` once verification ran — line 412: `return {
  ...planResult, verify, reviewRounds }`); `results[1]` — present only when
  `results[0].status === 'planned'` (line 728: `if (planResult.status !==
  'planned') return [planResult]`) — is the implement result from
  `runImplement()` (line 450: `return { stage: 'implement', ...result,
  files: preparedTask.files, fenceViolations }`). `verify` itself is the
  verifier's `{task, verdict, notes, reviewer, missingFiles}` (schema at
  lines 35-45).

`scripts/tackleTasksBrief.ts` currently tells the orchestrator to read
`result.status` and `result.lastFailure` directly (there is no such
top-level field — only `result.results[0].status` /
`result.results[0].lastFailure` exist), and never tells the orchestrator
which `results` member holds the fence violations or the verifier verdict
for the `plan+implement` notification. `tests/runMergePhase.test.ts` already
know the true shape (it manually indexes `...Result.results[0]` at what is
currently lines 272 and 279) but that correct indexing lives only in test
code, not in the instructions a literal executor follows.

## Edits to `scripts/tackleTasksBrief.ts`

All three edits are inside the `tackleTasksBrief` template literal (the
backticks below are the literal escaped backticks `` \` `` already present
in the source, reproduced exactly as they must appear after the edit).

### Edit 1 — add a "Task workflow results" section naming the one result type per stage

Insert a new section immediately before the existing `## Gate each task`
heading, so the documented result shapes are available to both the Gate
section (edit 2) and the Merge queue section (edit 3) that follow it.

Current text (lines 89–94):
```
Each task workflow's completion sends a task-notification back to you. That
notification — not polling — is how you learn a task is ready.

## Gate each task

The moment a task's own task-notification says it finished plan+implement,
```

Becomes:
```
Each task workflow's completion sends a task-notification back to you. That
notification — not polling — is how you learn a task is ready.

## Task workflow results

Every task.workflow.js run returns \`{task, stage, results}\`, where
\`results\` is an array of per-step results for that run's \`stage\`:

- \`rebase-test\`: \`results\` has one entry, the rebase-test result —
  \`{status, lastFailure, fenceViolations, ...}\`. \`status\` is
  \`"green"\` on success; anything else is a failure, with \`lastFailure\`
  naming why.
- \`merge\`: \`results\` has one entry, the merge result —
  \`{status, mergedCommitHash, closeError, ...}\`. \`status\` is
  \`"merged"\` or \`"merged-but-not-closed"\` on success; anything else is
  a failure.
- \`plan+implement\`: \`results[0]\` is the plan result —
  \`{status, verify, reviewRounds, ...}\`. When \`results[0].status\` is
  \`"planned"\`, \`results[0].verify\` is the verifier result
  \`{verdict, notes, reviewer, missingFiles}\`, and \`results[1]\` is the
  implement result \`{status, summary, remaining, notesFile,
  fenceViolations}\`. When \`results[0].status\` is not \`"planned"\`,
  \`results[1]\` does not exist.

## Gate each task

The moment a task's own task-notification says it finished plan+implement,
```

### Edit 2 — map the Gate section's fence violations and codex objections to specific `results` members

Current text (lines 102–111):
```
Call \`AskUserQuestion\` once for that task. Include an explicit decision
for the task itself — "Approve for merge" or "Do not approve" — alongside
its status, the fence violations the implement stage recorded for it
(task 138), and the codex objections that survived that task's
plan-review rounds (task 135). Present each fence violation and each
surviving objection as its own proposed task, separate from the approval
decision, that the user can accept or reject. For every proposed task the
user accepts, invoke the \`create-task\` skill once, never edit
\`tasks.json\` directly. Drop every proposed task the user rejects without
recording it anywhere.
```

Becomes:
```
Call \`AskUserQuestion\` once for that task. Include an explicit decision
for the task itself — "Approve for merge" or "Do not approve" — alongside
its status, the fence violations the implement stage recorded for it
(task 138), read from \`results[1].fenceViolations\` when \`results[1]\`
exists, and the codex objections that survived that task's
plan-review rounds (task 135), read from \`results[0].verify.notes\`.
Present each fence violation and each
surviving objection as its own proposed task, separate from the approval
decision, that the user can accept or reject. For every proposed task the
user accepts, invoke the \`create-task\` skill once, never edit
\`tasks.json\` directly. Drop every proposed task the user rejects without
recording it anywhere.
```

### Edit 3 — make merge-queue step 2 read `results[0]` instead of a nonexistent top-level field

Current text (line 147, one paragraph):
```
2. When a launched rebase-test or merge workflow's completion notification arrives, read its result's \`status\` (\`green\` is success for \`rebase-test\`; \`merged\` or \`merged-but-not-closed\` is success for \`merge\`; anything else is a failure, with \`lastFailure\` naming why). Run \`recordStageOutcome(queue, taskNumber, stage, outcome)\` — \`outcome\` is \`{"status":"success"}\` or \`{"status":"failure","reason":lastFailure}\` — and record the printed JSON as the new \`queue\`. If the merge stage reported \`merged-but-not-closed\`, also run \`recordMergedNotClosed(queue, taskNumber, mergedCommitHash, closeError)\` and record that printed JSON as the new \`queue\`. Remove that task's entry from \`outstandingEntries\`. Then go back to step 1.
```

Becomes:
```
2. When a launched rebase-test or merge workflow's completion notification arrives, its result is \`{task, stage, results}\`; read \`results[0].status\` (\`green\` is success for \`rebase-test\`; \`merged\` or \`merged-but-not-closed\` is success for \`merge\`; anything else is a failure, with \`results[0].lastFailure\` naming why). Run \`recordStageOutcome(queue, taskNumber, stage, outcome)\` — \`outcome\` is \`{"status":"success"}\` or \`{"status":"failure","reason":lastFailure}\`, where \`lastFailure\` is \`results[0].lastFailure\` — and record the printed JSON as the new \`queue\`. If the merge stage reported \`merged-but-not-closed\`, also run \`recordMergedNotClosed(queue, taskNumber, mergedCommitHash, closeError)\`, where \`mergedCommitHash\` is \`results[0].mergedCommitHash\` and \`closeError\` is \`results[0].closeError\`, and record that printed JSON as the new \`queue\`. Remove that task's entry from \`outstandingEntries\`. Then go back to step 1.
```

No other part of `scripts/tackleTasksBrief.ts` needs to change: the top
command table's `Outcome:` and `Merged-not-closed:` bullets (current lines
134–135) only name the `recordStageOutcome`/`recordMergedNotClosed` calls
and their argument names — they never claim a source location for
`lastFailure`/`mergedCommitHash`/`closeError`, so they are not part of the
bug. `readStdin`, `fail`, and the CLI entry block (lines 167–189) are
unrelated to the driver prose and need no change.

## Why `skills/tackle-tasks/task.workflow.js` needs no edit

The brief's fix is to make the generated driver text in
`scripts/tackleTasksBrief.ts` match the envelope `task.workflow.js` already
returns — not to change that envelope. `task.workflow.js` already returns
`{task, stage, results}` for every stage (line 736) and each stage runner
already produces exactly the per-stage shapes documented in Edit 1 above
(`runRebaseTest`, `runMerge`, `runPlan`, `runImplement`). No line in
`task.workflow.js` needs to change.

## Edits to `tests/tackleTasksBrief.test.ts`

### Edit 4 — widen the imports

Current text (lines 1–8):
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

Becomes:
```
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { compileFunction, constants as vmConstants } from "node:vm";
import { tackleTasksBrief } from "../scripts/tackleTasksBrief.ts";
import { TASKS_PER_COMMAND } from "../scripts/taskStats.ts";
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from "../scripts/repositoryManifest.ts";
```

### Edit 5 — append two new tests that drive real (non-synthetic) `task.workflow.js` runs

Current text (last two lines of the file, end of the existing "the
superseded workflow files are deleted..." test, currently lines 116–117):
```
  assert.equal(matches.trim(), "");
});
```

Becomes (same two lines, followed by new fixture helpers and two new
`test(...)` calls, appended at end of file):
```
  assert.equal(matches.trim(), "");
});

const REPO_ROOT_FOR_WORKFLOW = fileURLToPath(new URL("..", import.meta.url));
const TASK_WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT_FOR_WORKFLOW, "skills/tackle-tasks/task.workflow.js"), "utf8")
  .replace("export const meta", "const meta");

type TaskWorkflowResult = { task: number; stage: string; results: Array<Record<string, unknown>> };
type TaskWorkflowRunner = (argsJson: string, log: (...values: unknown[]) => void, agent: (...values: unknown[]) => Promise<unknown>) => Promise<TaskWorkflowResult>;

// ponytail: duplicated from tests/runMergePhase.test.ts rather than importing a .test.ts module,
// which would re-register that file's own tests under this file's run. Extract to a shared
// helper module if a third caller needs the same fixture.
const runTaskWorkflowStage = async (worktreePath: string, args: Record<string, unknown>, agent: (...values: unknown[]) => Promise<unknown>) => {
  const fn = compileFunction(
    `return (async () => { 'use strict'\n${TASK_WORKFLOW_SOURCE} })()`,
    ["args", "log", "agent"],
    { filename: join(REPO_ROOT_FOR_WORKFLOW, "skills/tackle-tasks/task.workflow.js"), importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  ) as TaskWorkflowRunner;
  return await fn(JSON.stringify({ worktree: worktreePath, ...args }), () => {}, agent);
};

const gitForWorkflowFixture = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const makeWorkflowFixtureRepo = (taskNumber: number) => {
  const root = mkdtempSync(join(tmpdir(), "tackle-tasks-brief-fixture-root-"));
  gitForWorkflowFixture(root, "init", "-q", "-b", "main");
  gitForWorkflowFixture(root, "config", "user.email", "test@example.com");
  gitForWorkflowFixture(root, "config", "user.name", "Test");
  gitForWorkflowFixture(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "root\n");
  gitForWorkflowFixture(root, "add", "README.md");
  gitForWorkflowFixture(root, "commit", "-q", "-m", "init");
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  gitForWorkflowFixture(root, "add", "package.json");
  gitForWorkflowFixture(root, "commit", "-q", "-m", "add test script");
  const sourceBranch = "main";
  const baseOid = gitForWorkflowFixture(root, "rev-parse", sourceBranch);
  const operationBranch = `task-${taskNumber}`;
  const worktreePath = join(tmpdir(), `tackle-tasks-brief-fixture-wt-${randomUUID()}`);
  gitForWorkflowFixture(root, "worktree", "add", "-q", "-b", operationBranch, worktreePath, sourceBranch);
  mkdirSync(join(worktreePath, "plans"), { recursive: true });
  symlinkSync(join(REPO_ROOT_FOR_WORKFLOW, "scripts"), join(worktreePath, "scripts"));
  mkdirSync(join(root, ".taskTools"), { recursive: true });
  const taskRecord = { taskNumber, title: "fixture", files: [], blockedBy: [] };
  writeFileSync(join(root, ".taskTools", "tasks.json"), JSON.stringify([taskRecord]));
  writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]");
  mkdirSync(join(worktreePath, ".taskTools"), { recursive: true });
  writeFileSync(join(worktreePath, ".taskTools", "tasks.json"), JSON.stringify([taskRecord]));
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

const throwingAgentForWorkflowFixture = async () => { throw new Error("this stage must not call an agent"); };

test("generated brief's results[] references match a real, non-synthetic task.workflow.js envelope for rebase-test and merge", async () => {
  const taskNumber = 9171;
  const { root, worktreePath, repositoryManifest } = makeWorkflowFixtureRepo(taskNumber);
  try {
    writeFileSync(join(worktreePath, "taskfile.txt"), "task change\n");
    gitForWorkflowFixture(worktreePath, "add", "taskfile.txt");
    gitForWorkflowFixture(worktreePath, "commit", "-q", "-m", "task change");

    const rebaseTestResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "rebase-test", repositoryManifest }, throwingAgentForWorkflowFixture);
    const rebaseTestOutcome = rebaseTestResult.results[0] as { status: string };
    assert.equal((rebaseTestResult as unknown as { status?: string }).status, undefined);
    assert.equal(typeof rebaseTestOutcome.status, "string");

    const mergeResult = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "merge", repositoryManifest }, throwingAgentForWorkflowFixture);
    const mergeOutcome = mergeResult.results[0] as { status: string; mergedCommitHash?: string };
    assert.equal((mergeResult as unknown as { status?: string }).status, undefined);
    assert.equal(typeof mergeOutcome.status, "string");
    assert.equal(typeof mergeOutcome.mergedCommitHash, "string");
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated brief's results[0]/results[1] mapping for plan+implement matches a real, non-synthetic workflow envelope, and the brief text names those paths", async () => {
  const taskNumber = 9172;
  const { root, worktreePath, repositoryManifest } = makeWorkflowFixtureRepo(taskNumber);
  const fakeAgent = async (_briefText: string, options: { label: string }) => {
    if (options.label.startsWith("plan:")) return { task: taskNumber, status: "planned", planFile: join(worktreePath, `plans/task-${taskNumber}-plan.md`), question: "" };
    if (options.label.startsWith("verify:")) return { task: taskNumber, verdict: "approved", notes: "looks good", reviewer: "codex", missingFiles: [] };
    if (options.label.startsWith("implement:")) return { task: taskNumber, status: "done", summary: "did it", remaining: [], notesFile: join(worktreePath, `plans/task-${taskNumber}-implementation-notes.md`) };
    throw new Error(`unexpected agent label ${options.label}`);
  };
  try {
    const result = await runTaskWorkflowStage(worktreePath, { task: taskNumber, stage: "plan+implement", repositoryManifest }, fakeAgent);
    const planOutcome = result.results[0] as { status: string; verify?: { verdict: string } };
    const implementOutcome = result.results[1] as { fenceViolations: unknown[] };
    assert.equal((result as unknown as { status?: string }).status, undefined);
    assert.equal(planOutcome.status, "planned");
    assert.equal(planOutcome.verify?.verdict, "approved");
    assert.ok(Array.isArray(implementOutcome.fenceViolations));

    const brief = tackleTasksBrief("[1]", "task 1: unblocked");
    assert.match(brief, /results\[0\]\.status/);
    assert.match(brief, /results\[0\]\.lastFailure/);
    assert.match(brief, /results\[1\]\.fenceViolations/);
    assert.match(brief, /results\[0\]\.verify/);
  } finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
```

## Why `tests/runMergePhase.test.ts` needs no edit

Its existing assertions (`rebaseTestResult.results[0]` /
`mergeResult.results[0]` in what is currently the
`test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged`
test) already match the real envelope and are not affected by the prose
changes in `scripts/tackleTasksBrief.ts` — that file only asserts against
`runMergePhase.ts`'s queue functions and the raw `task.workflow.js` result
shape, never against the generated brief text. No line in it needs to
change.

## Verification

Run, from the repo root:

1. `npx tsc --noEmit`
   Expect: exits 0, no type errors (the new test file additions are typed
   with explicit `as {...}` casts matching the existing style in
   `tests/runMergePhase.test.ts`, and `RepositoryManifest` /
   `REPOSITORY_MANIFEST_VERSION` are imported from the same path already
   used there).

2. `npm test`
   Expect: exits 0. Among the printed test results:
   - `tests/tackleTasksBrief.test.ts`'s existing tests still pass, including
     `"gate: each finished task is presented as one AskUserQuestion gate, never batched"`
     and
     `"merge queue: an approved task launches rebase-test then merge, and the brief never mentions the close-tasks skill"`
     (their regex assertions on `results[0]`-derived phrases like
     `"immediately ask that task's own approval gate"` and
     `"recordStageOutcome(queue, taskNumber, stage, outcome)"` are unaffected
     by edits 1–3, since those edits only add clauses after the matched
     substrings or touch step 2's paragraph, which no existing assertion
     targets).
   - the two new tests pass:
     `"generated brief's results[] references match a real, non-synthetic task.workflow.js envelope for rebase-test and merge"`
     and
     `"generated brief's results[0]/results[1] mapping for plan+implement matches a real, non-synthetic workflow envelope, and the brief text names those paths"`.
   - `tests/runMergePhase.test.ts`'s
     `test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged`
     still passes unchanged.

3. `node --experimental-strip-types -e "import('./scripts/tackleTasksBrief.ts').then(m => console.log(m.tackleTasksBrief('[1]', 'task 1: unblocked').includes('results[0].status')))"`
   Expect: prints `true` (confirms the generated brief text contains the new
   `results[0].status` wording from edit 3).
</content>
</invoke>
