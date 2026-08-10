# Task 86 Codex audit fixes

This is the implementation guide for the findings that remained open after tasks 166-173 were re-audited:

- C86-01 — planner/implementer worktree isolation
- C86-05 — executable wait-versus-retry scheduling
- C86-06 — executable workflow-result consumption
- C86-07 — total failure reporting and real failure-path coverage
- C86-08 — real task-state concurrency control and authoritative-root plumbing
- C86-09 — archive the fresh closing record without a fallible post-removal correction
- C86-10 — delete source-submodule task branches only after successful close
- C86-13 — preserve typecheck attribution and test the real rebase-test stage
- C86-14 — never guess a missing merge-time commit record
- C86-15 — exercise the complete production-shaped orchestration matrix
- C86-17 — remove the last internal renumbering drift and test document identity

The snippets below are targeted replacements against the current `task-86-chain` HEAD. Ellipses mean “retain the surrounding code unchanged.” Implement C86-08's `sourceRoot` plumbing before the C86-01 isolation test, implement C86-06's result consumer before adding C86-07's end-to-end failure tests, and implement C86-08's shared task-state lock before C86-09's single-snapshot close transaction.

## C86-01 — force planner and implementer agents into the prepared worktree

Passing `ARGS.worktree` fixed the enclosing workflow's direct Node/Git operations, but the planner and implementer prompts still contain repo-relative file names and bare shell/Git commands. Those agents can therefore edit and commit in the orchestrator checkout.

### `skills/tackle-tasks/task.workflow.js`: root every planner path

Old:

```js
const plannerBrief = (t, preamble = '') => `${preamble}Invoke /ponytail:ponytail ultra.
Read this brief file: ${t.briefFile}
You may also READ these owned files, and nothing else: ${t.files.join(', ')}
Read them — a plan that guesses at their contents will be rejected by the reviewer.
Follow ~/.claude/guides/planning.md and write the plan to exactly this path: ${t.planFile}
```

New:

```js
const worktreePath = (t, relativePath) =>
  `${t.repoRoot.replace(/\/+$/, '')}/${relativePath}`

const shellQuote = (value) =>
  `'${String(value).replaceAll("'", "'\"'\"'")}'`

const ownedPathMap = (t) => t.files
  .map((file) => `  - ${file} => ${worktreePath(t, file)}`)
  .join('\n')

const plannerBrief = (t, preamble = '') => `${preamble}Invoke /ponytail:ponytail ultra.
taskWorktree = ${t.repoRoot}
Read this brief file by its absolute path: ${t.briefFile}
Owned files (repo-relative => absolute in taskWorktree):
${ownedPathMap(t)}

For every filesystem tool call, use the absolute taskWorktree path shown above.
Never resolve a repo-relative task path against your ambient working directory,
and never read or edit the same relative path in another checkout.

Read the owned files — a plan that guesses at their contents will be rejected.
Follow ~/.claude/guides/planning.md and write the plan to exactly this absolute path: ${t.planFile}
```

Keep the rest of the planner constraints, but change references to “the owned list” to “the absolute owned paths above.” The brief, plan, and global planning guide remain the explicit non-source exceptions.

### `skills/tackle-tasks/task.workflow.js`: root every implementer operation

Old:

```js
const workerBrief = (t, note) => `You are implementing EXACTLY ONE pre-planned task from
./.taskTools/tasks.json: #${t.number}.

...
ownedFiles = ${t.files.join(', ')}
plan = ${t.planFile}
notesFile = ${t.notesFile}
...
implement every step of the plan, editing only ownedFiles

typecheck = run(${TYPECHECK_COMMAND})
...
if scripts/relatedTests.ts exists:
    tests = run it to discover the tests covering ownedFiles
...
if typecheck is clean and every test passed:
    run: git add -- ...
    run: git commit -m "task ${t.number}: one-line summary"
```

New:

```js
const workerBrief = (t, note) => {
  const notesRelative = `plans/task-${t.number}-implementation-notes.md`
  const rootedTypecheck = `(cd -- ${shellQuote(t.repoRoot)} && ${TYPECHECK_COMMAND})`
  const gitAddPaths = [...t.files, notesRelative].map(shellQuote).join(' ')

  return `You are implementing EXACTLY ONE pre-planned task from
${worktreePath(t, '.taskTools/tasks.json')}: #${t.number}.

taskWorktree = ${t.repoRoot}
ownedFiles = ${t.files.join(', ')}
ownedPaths (the only editable source/test paths) =
${ownedPathMap(t)}
plan = ${t.planFile}
notesFile = ${t.notesFile}
timeBudget = 10 minutes
${note ? `note = ${note}\n` : ''}
${tddInstruction(t)}

Treat taskWorktree as the project root for jot:implement. Every repo-relative
path in the plan means its absolute path under taskWorktree. Use absolute paths
for Read/Edit/Search. Never edit the corresponding path in the ambient checkout.

use jot:implement ${t.planFile}, writing its implementation-notes log to exactly notesFile

implement every step of the plan, editing only ownedPaths

typecheck = run(${rootedTypecheck})
if typecheck reported errors in ownedPaths:
    fix them using their absolute taskWorktree paths

if ${worktreePath(t, 'scripts/relatedTests.ts')} exists:
    tests = run it from taskWorktree to discover the tests covering ownedFiles
else:
    tests = the absolute test paths under taskWorktree belonging to ownedFiles

results = run every test command as (cd -- ${shellQuote(t.repoRoot)} && <test command>)
...
if typecheck is clean and every test passed:
    run: git -C ${shellQuote(t.repoRoot)} add -- ${gitAddPaths}
    run: git -C ${shellQuote(t.repoRoot)} commit -m ${shellQuote(`task ${t.number}: one-line summary`)}
    return {task: ${t.number}, status: "done", summary: one sentence, remaining: [], notesFile: notesFile}
...
You are forbidden to use an ambient-cwd-relative filesystem path or a bare Git
command. Every Git command must use git -C taskWorktree, and every other shell
command must explicitly run inside taskWorktree.`
}
```

Retain the existing retry, partial/blocked, test-fix-round, and file-fence clauses in the `...` positions.

### `skills/tackle-tasks/task.workflow.js`: reject false success

Old (`runImplement`):

```js
if (result.status === 'partial') {
  const note = `A previous worker finished part of this plan; still remaining: ${result.remaining.join('; ')}. Check the file state before redoing anything.`
  result = (await runWorker(preparedTask, note)) ?? result
}
const notesRelative = preparedTask.notesFile.slice(preparedTask.repoRoot.length + 1)
```

New:

```js
if (result.status === 'partial') {
  const note = `A previous worker finished part of this plan; still remaining: ${result.remaining.join('; ')}. Check the file state before redoing anything.`
  result = (await runWorker(preparedTask, note)) ?? result
}

const headAfter = execFileSync(
  'git',
  ['-C', preparedTask.repoRoot, 'rev-parse', 'HEAD'],
  { encoding: 'utf8' },
).trim()
if (result.status === 'done' && headAfter === base) {
  result = {
    ...result,
    status: 'blocked',
    summary: 'implementer reported done but made no commit in taskWorktree',
    remaining: ['commit the implementation in the prepared task worktree'],
  }
}

const notesRelative = preparedTask.notesFile.slice(preparedTask.repoRoot.length + 1)
```

Also require `existsSync(preparedTask.planFile)` before accepting planner status `planned`; otherwise return `needs-clarification` saying that the planner did not write the plan inside the task worktree.

### Regression test

Replace the current one-task, merge-only isolation claim with a two-task `plan+implement` test:

```ts
test('plan+implement commits only in each prepared task worktree', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const args = buildWorkflowArguments(root, 'npx tsc --noEmit', tasks)
  const sourceHead = git(root, 'rev-parse', 'HEAD')
  const sourceStatus = git(root, 'status', '--porcelain')
  const cwd = process.cwd()

  await Promise.all(args.groups.map(async (group) => {
    const task = group.tasks[0]!
    const scriptedAgent = agentThatUsesOnlyAbsolutePathsAndCommitsWithGitC(group.worktree)
    const result = await runTaskWorkflowAtRealScriptPath({
      task: task.number,
      stage: 'plan+implement',
      typecheckCommand: args.typecheckCommand,
      worktree: group.worktree,
      sourceRoot: root,
    }, scriptedAgent)
    assert.equal(result.results[1].status, 'done')
  }))

  assert.equal(process.cwd(), cwd)
  assert.equal(git(root, 'rev-parse', 'HEAD'), sourceHead)
  assert.equal(git(root, 'status', '--porcelain'), sourceStatus)
  assertTaskCommitExistsOnlyIn(args.groups[0]!.worktree, 1)
  assertTaskCommitExistsOnlyIn(args.groups[1]!.worktree, 2)
})
```

Add a negative case where the implementer returns `done` without committing; the workflow must return `blocked`. Do not call `process.chdir`, relocate the compiled workflow filename, pre-create the task commits, or use a fake implementer that merely reports `done`.

## C86-05 — make wait/begin-next-lap an executable state-machine decision

The prose now says to wait while another workflow is outstanding, but the behavior is not represented by executable code and the required transition test is absent.

### `scripts/runMergePhase.ts`: add a scheduler action

Old:

```ts
export function shouldEndQueue(queue: MergeQueue, workflowOutstanding: boolean): QueueEndState {
    if (workflowOutstanding || !currentLapIsComplete(queue)) return "continue";
    if (queue.mergedThisLap === 0 && (queue.carryover.length > 0 || queue.unmerged.length > 0)) return "stuck";
    return queue.carryover.length === 0 ? "done" : "continue";
}
```

New (retain `shouldEndQueue` and add this immediately after it):

```ts
export type OutstandingWorkflowState = { any: boolean; tail: boolean };

export type QueueAction =
    | { kind: "launch"; step: QueueStep }
    | { kind: "wait" }
    | { kind: "begin-next-lap" }
    | { kind: "report"; endState: Exclude<QueueEndState, "continue"> };

export function nextQueueAction(
    queue: MergeQueue,
    outstanding: OutstandingWorkflowState,
): QueueAction {
    const step = nextQueueStep(queue);
    if (step) return outstanding.tail ? { kind: "wait" } : { kind: "launch", step };

    const endState = shouldEndQueue(queue, outstanding.any);
    if (endState !== "continue") return { kind: "report", endState };
    if (queue.carryover.length > 0 && !outstanding.any) return { kind: "begin-next-lap" };
    return { kind: "wait" };
}
```

`tail` must mean that an outstanding entry is `rebase-test` or `merge`; an unrelated task still planning must not prevent an already approved task from launching its serial tail.

### `scripts/tackleTasksBrief.ts`: execute the scheduler instead of restating it

Old:

```text
1. Run nextQueueStep(queue) ... inspect outstandingEntries and decide whether to launch or wait.
...
3. Run shouldEndQueue(queue, workflowOutstanding) ... inspect carryover and decide whether to call beginNextLap or wait.
```

New:

```text
After every enqueue and completion notification, compute:

outstanding = {
  any: outstandingEntries.size > 0,
  tail: [...outstandingEntries.values()].some(
    stage => stage === "rebase-test" || stage === "merge"
  ),
}

Run nextQueueAction(queue, outstanding) through the quoted Node heredoc.
- kind "launch": launch action.step and add it to outstandingEntries.
- kind "wait": wait for the next enqueue or completion notification.
- kind "begin-next-lap": run beginNextLap(queue), save the returned queue, and repeat.
- kind "report": run buildMergeReport(queue), report it, and stop the queue.

Do not derive a different action from pending, carryover, or outstandingEntries in prose.
```

Add `nextQueueAction` to the generated heredoc function table.

### `tests/runMergePhase.test.ts`: full transition test

Old:

```ts
assert.equal(shouldEndQueue(queue, true), "continue");
```

New:

```ts
test('failed A waits for outstanding B, then retries only after B advances the lap', () => {
    let queue = createMergeQueue();
    let sourceTip = 'tip-before-b';
    const attemptedTips: string[] = [];

    queue = enqueueApprovedTask(queue, 1);
    attemptedTips.push(sourceTip);
    queue = recordStageOutcome(queue, 1, 'rebase-test', {
        status: 'failure', reason: 'A conflict',
    });

    assert.deepEqual(nextQueueAction(queue, { any: true, tail: false }), { kind: 'wait' });
    assert.equal(queue.carryover[0]!.lapsAttempted, 1);
    assert.deepEqual(attemptedTips, ['tip-before-b']);

    queue = enqueueApprovedTask(queue, 2);
    assert.deepEqual(nextQueueAction(queue, { any: false, tail: false }), {
        kind: 'launch', step: { taskNumber: 2, stage: 'rebase-test' },
    });
    queue = recordStageOutcome(queue, 2, 'rebase-test', { status: 'success' });
    queue = recordStageOutcome(queue, 2, 'merge', { status: 'success' });
    sourceTip = 'tip-after-b';

    assert.deepEqual(nextQueueAction(queue, { any: false, tail: false }), {
        kind: 'begin-next-lap',
    });
    queue = beginNextLap(queue);
    assert.deepEqual(nextQueueAction(queue, { any: false, tail: false }), {
        kind: 'launch', step: { taskNumber: 1, stage: 'rebase-test' },
    });
    attemptedTips.push(sourceTip);
    queue = recordStageOutcome(queue, 1, 'rebase-test', {
        status: 'failure', reason: 'A conflict after B',
    });

    assert.deepEqual(attemptedTips, ['tip-before-b', 'tip-after-b']);
    assert.equal(queue.unmerged[0]!.lapsAttempted, 2);
});
```

The pure state-machine test is necessary but not sufficient by itself. Add an integration variant using the existing Git fixture helpers: record `git rev-parse main` before and after B's real merge, launch A's second real `rebase-test`, and assert B's merged commit is an ancestor of `task-A` afterward.

## C86-06 — consume workflow envelopes through executable code

The generated prose names `results[0]` and `results[1]` correctly now, but the tests manually repeat those indexes. There is still no executable driver contract protecting the mapping.

### `scripts/runMergePhase.ts`: add the canonical envelope consumer

Old:

```ts
export type StageOutcome = { status: "success" } | { status: "failure"; reason: string };

// The orchestrator manually reads envelope.results[n], builds StageOutcome,
// then calls recordStageOutcome and possibly recordMergedNotClosed.
```

New:

```ts
type JsonObject = Record<string, unknown>;

export type TaskWorkflowEnvelope = {
    task: number;
    stage: "plan+implement" | "rebase-test" | "merge";
    results: JsonObject[];
};

export type ApprovalView = {
    taskNumber: number;
    status: string;
    verifier: JsonObject | null;
    fenceViolations: unknown[];
};

export type ConsumedWorkflowResult =
    | { kind: "approval"; queue: MergeQueue; approval: ApprovalView }
    | { kind: "queue"; queue: MergeQueue; taskNumber: number; stage: QueueStage; status: string };

function objectAt(results: unknown[], index: number, label: string): JsonObject {
    const value = results[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`task workflow envelope has no ${label} result at results[${index}]`);
    }
    return value as JsonObject;
}

function nonemptyString(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value;
}

export function consumeTaskWorkflowResult(
    queue: MergeQueue,
    envelope: TaskWorkflowEnvelope,
): ConsumedWorkflowResult {
    if (envelope.stage === "plan+implement") {
        const plan = objectAt(envelope.results, 0, "plan");
        const implement = envelope.results.length > 1
            ? objectAt(envelope.results, 1, "implement")
            : null;
        return {
            kind: "approval",
            queue,
            approval: {
                taskNumber: envelope.task,
                status: String(implement?.status ?? plan.status),
                verifier: plan.verify && typeof plan.verify === "object"
                    ? plan.verify as JsonObject
                    : null,
                fenceViolations: Array.isArray(implement?.fenceViolations)
                    ? implement.fenceViolations
                    : [],
            },
        };
    }

    const result = objectAt(envelope.results, 0, envelope.stage);
    const status = nonemptyString(result.status, `${envelope.stage}.status`);
    const success = envelope.stage === "rebase-test"
        ? status === "green"
        : status === "merged" || status === "merged-but-not-closed";
    const outcome: StageOutcome = success
        ? { status: "success" }
        : {
            status: "failure",
            reason: nonemptyString(result.lastFailure, `${envelope.stage}.lastFailure`),
        };

    let next = recordStageOutcome(queue, envelope.task, envelope.stage, outcome);
    if (envelope.stage === "merge" && status === "merged-but-not-closed") {
        next = recordMergedNotClosed(
            next,
            envelope.task,
            nonemptyString(result.mergedCommitHash, "merge.mergedCommitHash"),
            nonemptyString(result.closeError, "merge.closeError"),
        );
    }
    return { kind: "queue", queue: next, taskNumber: envelope.task, stage: envelope.stage, status };
}
```

### `scripts/tackleTasksBrief.ts`: remove raw result indexing

Old:

```text
When a workflow completes, read results[0].status and results[0].lastFailure.
For plan+implement, read results[0].verify and results[1].fenceViolations.
Call recordStageOutcome and recordMergedNotClosed with the extracted fields.
```

New:

```text
When a task workflow completion notification arrives, pass its complete
{task, stage, results} JSON and the current queue to consumeTaskWorkflowResult.

For kind "approval", present consumed.approval.status,
consumed.approval.verifier, and consumed.approval.fenceViolations at that task's gate.
For kind "queue", replace queue with consumed.queue and continue with nextQueueAction.

Never index results[] or reconstruct StageOutcome in the conversation.
```

Add `consumeTaskWorkflowResult` to the heredoc function table and remove the separate “Outcome” and “Merged-not-closed” manual extraction steps.

### Regression tests

Old:

```ts
const outcome = workflowResult.results[0] as { status: string };
queue = recordStageOutcome(queue, taskNumber, stage, ...);
```

New:

```ts
const consumed = consumeTaskWorkflowResult(queue, workflowResult);
assert.equal(consumed.kind, 'queue');
if (consumed.kind !== 'queue') assert.fail('expected queue result');
queue = consumed.queue;
```

For `plan+implement`, feed the complete real workflow return to `consumeTaskWorkflowResult` and assert `consumed.approval.verifier` and `consumed.approval.fenceViolations` without indexing `results`. Add malformed-envelope cases for empty `results`, failed tail results without `lastFailure`, and `merged-but-not-closed` without a hash or `closeError`. Generated-brief tests should require `consumeTaskWorkflowResult` and reject `/results\[[01]\]/`.

## C86-07 — make every failure reason concrete and test real stage results through the queue

Cleanup failures are now structured, but merge conflicts can still return `lastFailure: null`; close failures lack a uniform `lastFailure`; and only cleanup is exercised through the real workflow-to-report path.

### `skills/tackle-tasks/task.workflow.js`: normalize merge failure reports

Old:

```js
if (report.status !== 'merged') {
  return { stage: 'merge', task: N, failedAtStage, ...report, lastFailure: report.failureReason }
}
```

New:

```js
const concreteMergeStageFailure = (report) => {
  const explicit = typeof report.failureReason === 'string'
    ? report.failureReason.trim()
    : ''
  if (explicit) return explicit

  const occurrence = report.status === 'parent-conflicted'
    ? 'root'
    : (report.occurrenceId || 'unknown layer')
  const conflictSuffix = Array.isArray(report.conflictedFilePaths)
    && report.conflictedFilePaths.length > 0
    ? `; unresolved paths: ${report.conflictedFilePaths.join(', ')}`
    : ''
  const kind = report.stage === 'merge'
    ? 'merge failure'
    : report.stage === 'rebase'
      ? 'rebase conflict'
      : 'test failure'
  return `${kind} in ${occurrence} (${report.status})${conflictSuffix}`
}

...
if (report.status !== 'merged') {
  return {
    stage: 'merge',
    task: N,
    failedAtStage,
    ...report,
    lastFailure: concreteMergeStageFailure(report),
  }
}
```

### `skills/tackle-tasks/task.workflow.js`: make close failures uniform

Old:

```js
} catch (error) {
  return { ...report, status: 'merged-but-not-closed', mergedCommitHash,
    closeError: String((error && error.message) || error) }
}
if (!closeResult.closed.includes(N)) {
  const closeError = `closeTasks did not close task ${N}: ...`
  return { ...report, status: 'merged-but-not-closed', mergedCommitHash, closeError }
}
```

New:

```js
} catch (error) {
  const closeError = `close failure: ${String((error && error.message) || error)}`
  return {
    stage: 'merge', task: N, failedAtStage, ...report,
    status: 'merged-but-not-closed', mergedCommitHash,
    closeError, lastFailure: closeError,
  }
}
if (!closeResult.closed.includes(N)) {
  const closeError = `close failure: closeTasks did not close task ${N}: closed [${closeResult.closed.join(', ')}], skipped [${closeResult.skipped.join(', ')}], unblocked [${closeResult.unblocked.join(', ')}]`
  return {
    stage: 'merge', task: N, failedAtStage, ...report,
    status: 'merged-but-not-closed', mergedCommitHash,
    closed: closeResult.closed, skipped: closeResult.skipped,
    unblocked: closeResult.unblocked,
    closeError, lastFailure: closeError,
  }
}
```

Keep the final `removeWorktreeAndBranch` catch warning-only: its inherited status remains `merged`, it carries `cleanupWarning`, and it must not add `lastFailure`.

### Real end-to-end tests

Feed every complete workflow envelope through `consumeTaskWorkflowResult`; do not synthesize `StageOutcome` in the tests.

```ts
test('real merge conflict produces a concrete final-report reason', async () => {
    const fixture = makeRootConflictFixture();
    let queue = queueAtMergeStage(fixture.taskNumber);
    const envelope = await runTaskWorkflowStage(fixture.worktreePath, {
        task: fixture.taskNumber,
        stage: 'merge',
        repositoryManifest: fixture.repositoryManifest,
        sourceRoot: fixture.root,
    });

    const consumed = consumeTaskWorkflowResult(queue, envelope);
    assert.equal(consumed.kind, 'queue');
    if (consumed.kind !== 'queue') assert.fail('expected queue result');
    queue = consumed.queue;
    const report = buildMergeReport(queue);
    assert.equal(typeof report.unmerged[0]!.lastFailure, 'string');
    assert.match(report.unmerged[0]!.lastFailure, /rebase conflict/);
    assert.match(report.unmerged[0]!.lastFailure, /conflicted-file\.ts/);
});
```

Add three sibling cases:

1. Cleanup hook failure returns `blocked` and reaches `buildMergeReport` with the same nonempty `lastFailure`.
2. Real close failure returns equal, nonempty `closeError`/`lastFailure`; the consumer records a successful merge plus one `mergedNotClosed` report entry.
3. Force final worktree removal to fail after close; assert status `merged`, nonempty `cleanupWarning`, no `lastFailure`, task present in `queue.merged`, and no `unmerged`/`mergedNotClosed` report entry.

The existing “completedTasks.json is a directory” fixture can produce the close error. A second checkout holding `task-N` can make final branch deletion fail and exercise the warning-only path without mocking dependencies.

## C86-08 — replace the non-atomic hash guard with one authoritative-root lock

`hashGuardedRewrite` has an acknowledged re-hash-to-rename gap: two processes can both validate the old hash and then rename stale snapshots in sequence. The new nested callbacks exercise only the detectable interleaving. In addition, `runPlan` now reads `ARGS.repositoryManifest` even though initial launches do not pass it.

### New file: `scripts/taskStateLock.ts`

Old:

```ts
// No shared task-state mutex exists.
// hashGuardedRewrite checks a hash and later renames without exclusion.
```

New:

```ts
import {
    closeSync, fsyncSync, mkdirSync, openSync,
    renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const WAIT = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_TIMEOUT_MS = 10_000;

export function taskStateLockPath(sourceRoot: string): string {
    return join(sourceRoot, '.taskTools', 'task-state.lock');
}

export function withTaskStateLock<T>(
    sourceRoot: string,
    action: () => T,
    { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
): T {
    const lockPath = taskStateLockPath(sourceRoot);
    mkdirSync(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    let fd: number | null = null;

    while (fd === null) {
        try {
            fd = openSync(lockPath, 'wx', 0o600); // atomic exclusion point
            writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
            fsyncSync(fd);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (Date.now() >= deadline) {
                throw new Error(`task-state lock timed out; inspect stale lock manually: ${lockPath}`);
            }
            Atomics.wait(WAIT, 0, 0, 10);
        }
    }

    try {
        return action();
    } finally {
        closeSync(fd);
        try {
            unlinkSync(lockPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
}

export function writeJsonAtomically(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try {
        writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, path);
}
```

Do not auto-delete a purportedly stale lock by age: checking age and then renaming/unlinking has its own race with a successor owner. This minimal implementation fails safely on timeout and requires explicit stale-lock recovery. If automatic stale recovery is required, use a proven lock library rather than adding another check-then-act path.

### `scripts/addTaskFiles.ts`: hold one lock across both authoritative files

Old:

```ts
const tasks = hashGuardedRewrite<TaskRecord[]>(pair.tasksPath, mutateTasks);
refreshRunArgumentsSnapshot(repoRoot, tasks); // a separate hash-guarded transaction
return tasks;
```

New:

```ts
export function addTaskFiles(
    taskNumbers: number[],
    paths: string[],
    sourceRoot: string,
): TaskRecord[] {
    const rejected = firstRejectedPath(paths);
    if (rejected) throw new Error(`addTaskFiles: rejected ${rejected}`);

    return withTaskStateLock(sourceRoot, () => {
        const pair = resolveTaskFiles(sourceRoot);
        const tasks = JSON.parse(readFileSync(pair.tasksPath, 'utf8')) as TaskRecord[];
        const present = new Set(tasks.map((task) => task.taskNumber));
        const missing = taskNumbers.filter((number) => !present.has(number));
        if (missing.length > 0) {
            throw new Error(`addTaskFiles: not found in tasks.json: ${missing.join(', ')}`);
        }
        for (const task of tasks) {
            if (taskNumbers.includes(task.taskNumber)) appendFiles(task, paths);
        }

        const argumentsPath = resolveRunArgumentsPath(sourceRoot);
        let snapshot: RunArgumentsSnapshot | null = null;
        if (existsSync(argumentsPath)) {
            snapshot = JSON.parse(readFileSync(argumentsPath, 'utf8')) as RunArgumentsSnapshot;
            refreshRunArgumentsSnapshotInMemory(snapshot, tasks);
        }

        writeJsonAtomically(pair.tasksPath, tasks);
        if (snapshot) writeJsonAtomically(argumentsPath, snapshot);
        return tasks;
    });
}
```

Split the current snapshot mutation loop into the pure `refreshRunArgumentsSnapshotInMemory(snapshot, tasks)` helper. Make `sourceRoot` mandatory for library callers; the CLI can pass `process.cwd()` explicitly.

### `scripts/closeTasks.ts` and every task-state writer: use the same lock

Old:

```ts
export function closeTasks(...) {
    const tasks = JSON.parse(readFileSync(tasksPath, 'utf8'));
    ...
    hashGuardedRewrite(completedTasksPath, ...);
    hashGuardedRewrite(tasksPath, ...);
}
```

New:

```ts
export function closeTasks(
    taskNumbers: number[],
    closureNote: string | Record<number, string>,
    projectRoot: string = process.cwd(),
    commitHashes: string[] | Record<number, string[]> = [],
): CloseTasksResult {
    return withTaskStateLock(projectRoot, () =>
        closeTasksLocked(taskNumbers, closureNote, projectRoot, commitHashes));
}

function closeTasksLocked(...): CloseTasksResult {
    // Move the current entire body here. All initial reads happen after lock acquisition.
    // Build both fresh in-memory results from one snapshot.
    // Publish completedTasks first and tasks second, as detailed in C86-09.
}
```

Migrate all other writers to the same authoritative-root lock; mixing locked and unlocked/hash-guarded writers leaves the guarantee false. Current migration anchors include:

- `scripts/prepareTasks.ts` when it creates `run-arguments.json`
- `scripts/blockerVerdicts.ts` CLI mutation
- `scripts/unblockDependents.ts` CLI mutation
- `scripts/taskArchival.ts` legacy batch archive
- any initialization write in `scripts/taskFiles.ts` that can race with an active run

The lock gives mutual exclusion, while `writeJsonAtomically` gives atomic publication of each file. Do not claim crash-atomic publication of both JSON files without adding a journal.

### Pass the authoritative root explicitly

Old (`scripts/tackleTasksBrief.ts`):

```text
{task, typecheckCommand, worktree}
...
{task: taskNumber, stage, repositoryManifest, worktree}
```

New:

```text
{task, typecheckCommand, worktree, sourceRoot}
sourceRoot is the top-level pipeline args repo value.
...
{task: taskNumber, stage, repositoryManifest, worktree, sourceRoot}
```

Old (`skills/tackle-tasks/task.workflow.js`):

```js
const mainRepoRoot = ARGS.repositoryManifest.occurrences
  .find((o) => o.occurrenceId === '').checkoutPath
...
addTaskFiles([N], missingFiles, mainRepoRoot)
```

New:

```js
const SOURCE_ROOT = ARGS.sourceRoot
if (!SOURCE_ROOT) {
  throw new Error('task.workflow.js: no "sourceRoot" in args')
}
...
const widenedTasks = addTaskFiles([N], missingFiles, SOURCE_ROOT)
```

In the merge stage, validate that the manifest root equals `SOURCE_ROOT`, then pass `SOURCE_ROOT` to `closeTasks`.

### Replace nested callbacks with real-process concurrency tests

Old:

```ts
addTaskFiles([1], ['from-a.ts'], root, () => {
    addTaskFiles([2], ['from-b.ts'], root);
});
```

New shape:

```ts
test('concurrent CLI wideners preserve the full union in both authoritative files', async () => {
    const root = makeProjectRootWithRunArguments();
    const startFile = join(root, 'start');
    const paths = Array.from({ length: 16 }, (_, index) => `from-${index}.ts`);

    const children = paths.map((path) => spawnWidenChild({
        sourceRoot: root,
        taskNumber: 1,
        path,
        startFile,
    }));
    writeFileSync(startFile, 'go');
    await Promise.all(children.map(requireExitZero));

    assert.deepEqual(new Set(readTasks(root)[0]!.files), new Set(paths));
    assert.deepEqual(
        new Set(readRunArguments(root).groups[0].tasks[0].files),
        new Set(paths),
    );
});
```

Add two real widen/close process-order cases:

- Widener wins the lock, closer follows: the archived task includes the widened file, active task is absent, and the run snapshot contains the widening.
- Closer wins the lock, widener follows: the widener exits with “not found,” the task stays archived exactly once, and it is never resurrected.

Both processes must be live concurrently and synchronize through a start-file barrier. Add generated-brief assertions that both initial and tail launch arguments include `sourceRoot`, plus a workflow test proving a missing `sourceRoot` fails before touching either checkout.

## C86-09 — remove the fallible post-removal archive correction

Task 174 now captures the widened record from the successful guarded `tasks.json` removal attempt, but it writes that record to `completedTasks.json` only in a later correction step. If the correction fails, `tasks.json` no longer contains the task and `completedTasks.json` still contains the stale pre-widening record. The current failure-path test calls that “nothing is lost” but never asserts that the widened fields survived.

This fix depends on C86-08's shared authoritative-root lock. Under that lock, read the active task once, derive both output files from that same snapshot, publish the completed record first, and remove the active record second. There is no correction step.

### `scripts/closeTasks.ts`: replace the three-step archive/remove/correct flow

Old (current task 174 implementation):

```ts
// Step 1: archives records derived from the stale pre-transaction read.
const initialRecords = new Map(
  willClose.map((taskNumber) => [taskNumber, recordFor(taskNumber, tasks)]),
);
hashGuardedRewrite<TaskRecord[]>(completedTasksPath, (parsedCompleted) =>
  upsertInto(parsedCompleted, initialRecords));

// Step 2: removes from a guarded fresh tasks snapshot and remembers freshRecords.
let freshRecords = new Map<number, TaskRecord>();
hashGuardedRewrite<TaskRecord[]>(tasksPath, (parsedTasks) => {
  freshRecords = new Map(
    willClose.map((taskNumber) => [taskNumber, recordFor(taskNumber, parsedTasks)]),
  );
  const remaining = parsedTasks.filter((task) => !willClose.includes(task.taskNumber));
  unblocked = unblockDependents(remaining, willClose);
  return remaining;
}, afterTasksWriteAttempt);

// Step 3: after the task is already gone, tries to correct the stale archive.
const changedRecords = new Map(
  willClose
    .filter((taskNumber) =>
      JSON.stringify(freshRecords.get(taskNumber)) !== JSON.stringify(initialRecords.get(taskNumber)))
    .map((taskNumber) => [taskNumber, freshRecords.get(taskNumber)!]),
);
if (changedRecords.size > 0) {
  hashGuardedRewrite<TaskRecord[]>(
    completedTasksPath,
    (parsedCompleted) => upsertInto(parsedCompleted, changedRecords),
    afterCorrectionWriteAttempt,
  );
}
```

New (inside C86-08's `withTaskStateLock(projectRoot, ...)` callback):

```ts
function closeTasksLocked(
    taskNumbers: number[],
    closureNote: string | Record<number, string>,
    projectRoot: string,
    commitHashes: string[] | Record<number, string[]>,
): CloseTasksResult {
    const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot);
    const tasks = JSON.parse(readFileSync(tasksPath, 'utf8')) as TaskRecord[];
    const completed = JSON.parse(readFileSync(completedTasksPath, 'utf8')) as TaskRecord[];
    const completionDate = localDate();
    const requested = [...new Set(taskNumbers)];
    const skipped = requested.filter(
        (taskNumber) => !tasks.some((task) => task.taskNumber === taskNumber),
    );
    const willClose = requested.filter((taskNumber) => !skipped.includes(taskNumber));

    if (willClose.length === 0) return { closed: [], skipped, unblocked: [] };

    // Resolve caller-supplied values before either write.
    const resolved = new Map(willClose.map((taskNumber) => [taskNumber, {
        closureNote: noteFor(closureNote, taskNumber),
        commitHashes: hashesFor(commitHashes, taskNumber),
    }]));

    // The archived records and removals come from this exact same locked snapshot.
    const records = new Map(willClose.map((taskNumber) => {
        const task = tasks.find((entry) => entry.taskNumber === taskNumber)!;
        const values = resolved.get(taskNumber)!;
        return [taskNumber, {
            ...task,
            completionDate,
            commitHashes: values.commitHashes,
            closureNote: values.closureNote,
        }];
    }));

    const nextCompleted = upsertInto(completed, records);
    const remaining = tasks.filter((task) => !willClose.includes(task.taskNumber));
    const unblocked = unblockDependents(remaining, willClose);

    // Loss-proof order:
    // 1. If archive publication fails, tasks.json is untouched.
    // 2. If removal publication fails, the fresh task exists in BOTH files;
    //    a retry upserts the same archive and then completes the removal.
    writeJsonAtomically(completedTasksPath, nextCompleted);
    writeJsonAtomically(tasksPath, remaining);

    return { closed: willClose, skipped, unblocked };
}

export function closeTasks(
    taskNumbers: number[],
    closureNote: string | Record<number, string>,
    projectRoot: string = process.cwd(),
    commitHashes: string[] | Record<number, string[]> = [],
): CloseTasksResult {
    return withTaskStateLock(projectRoot, () =>
        closeTasksLocked(taskNumbers, closureNote, projectRoot, commitHashes));
}
```

Remove `afterTasksWriteAttempt`, `afterCorrectionWriteAttempt`, `initialRecords`, `freshRecords`, `changedRecords`, and the correction write. Concurrency tests should interleave real processes at the shared lock boundary rather than adding mutation hooks inside `closeTasks`.

This ordering intentionally permits a recoverable duplicate after a failure of the second write: the task can temporarily exist in both files, but its newest fields are never discarded. `upsertInto` makes retry idempotent.

### `tests/closeTasks.test.ts`: make the failure assertion check the raced fields

Old:

```ts
assert.throws(() =>
  closeTasks([65], 'fixed by abc123', root, [], afterTasksWriteAttempt, afterCorrectionWriteAttempt),
);

assert.deepEqual(readTasks(root).map((t) => t.taskNumber), []);
const completed = readCompleted(root).find((t) => t.taskNumber === 65);
assert.ok(completed, 'task 65 must still be archived even though the correction write failed');
// The test never checks completed.files, which is still the stale ["a.ts"].
```

New:

```ts
test('close archives the same widened record it removes', async () => {
    const root = makeProjectRootWithTask({
        taskNumber: 65,
        title: 'second',
        files: ['a.ts'],
    });

    // Run real widener and closer processes against the C86-08 lock.
    // Arrange for widening to acquire/release the lock first.
    const [widen, close] = startBarrierChildren([
        widenChild(root, 65, 'b.ts', { delayMs: 0 }),
        closeChild(root, 65, 'fixed by abc123', { delayMs: 50 }),
    ]);
    releaseBarrier(root);
    await requireExitZero(widen);
    await requireExitZero(close);

    assert.equal(readTasks(root).some((task) => task.taskNumber === 65), false);
    const archived = readCompleted(root).find((task) => task.taskNumber === 65)!;
    assert.deepEqual(archived.files, ['a.ts', 'b.ts']);
    assert.equal(archived.closureNote, 'fixed by abc123');
});

test('failure before removal leaves the fresh task recoverable without stale archival', () => {
    const root = makeProjectRootWithTask({
        taskNumber: 65,
        title: 'second',
        files: ['a.ts', 'b.ts'],
    });
    makeAtomicWriteFailFor(root, 'completedTasks.json');

    assert.throws(() => closeTasks([65], 'fixed by abc123', root));

    const active = readTasks(root).find((task) => task.taskNumber === 65)!;
    assert.deepEqual(active.files, ['a.ts', 'b.ts']);
    assert.equal(readCompleted(root).some((task) => task.taskNumber === 65), false);
});

test('failure after archive but before removal preserves the fresh record in both files for retry', () => {
    const root = makeProjectRootWithTask({
        taskNumber: 65,
        title: 'second',
        files: ['a.ts', 'b.ts'],
    });
    makeAtomicWriteFailFor(root, 'tasks.json');

    assert.throws(() => closeTasks([65], 'fixed by abc123', root));

    assert.deepEqual(readTasks(root).find((task) => task.taskNumber === 65)!.files, ['a.ts', 'b.ts']);
    assert.deepEqual(readCompleted(root).find((task) => task.taskNumber === 65)!.files, ['a.ts', 'b.ts']);

    restoreAtomicWrites(root);
    assert.deepEqual(closeTasks([65], 'fixed by abc123', root).closed, [65]);
    assert.equal(readTasks(root).some((task) => task.taskNumber === 65), false);
    assert.equal(readCompleted(root).filter((task) => task.taskNumber === 65).length, 1);
});
```

The key assertion is the widened `files` value in every recoverable state. Merely asserting that some record for task 65 exists is not sufficient.

## C86-10 — move source-submodule branch deletion after successful close

C86-10 was implemented by task 175, not task 177. Task 177 corresponds to C86-12 and correctly refuses to reset a worktree containing retained commits or edits.

Task 175 deletes the fetched `task-N` branch from each canonical source submodule, but it does so inside `mergeTaskDeepestFirst`, immediately after that submodule merges or is classified as a no-op. A later containing-layer/root failure or close failure therefore retains the root task branch/worktree while prematurely deleting the source-submodule refs. The revised test asserts this premature deletion and still calls the root cleanup helper manually instead of exercising the production close path.

### `scripts/mergeTaskWorktrees.ts`: retain refs during the merge walk

Old:

```ts
if (skippedOccurrenceIds.has(occurrence.occurrenceId)) {
    const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
    sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
    completedLayers.push({
        occurrenceId: displayId,
        checkoutPath: occurrence.checkoutPath,
        status: "no-op",
        oid,
    });
    if (occurrence.parentOccurrenceId !== null) {
        git(sourceCheckoutPath, "branch", "-D", occurrence.operationBranch);
    }
    continue;
}

...
if (!result.merged) {
    return { status: "submodule-conflicted", ... };
}
git(sourceCheckoutPath, "branch", "-D", occurrence.operationBranch);
const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
```

New:

```ts
if (skippedOccurrenceIds.has(occurrence.occurrenceId)) {
    const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
    sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
    completedLayers.push({
        occurrenceId: displayId,
        checkoutPath: occurrence.checkoutPath,
        status: "no-op",
        oid,
    });
    // Retain the fetched source-submodule task ref until the whole task closes.
    continue;
}

...
if (!result.merged) {
    return { status: "submodule-conflicted", ... };
}
// Do not delete occurrence.operationBranch here. Parent merge and close can still fail.
const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
```

### `scripts/mergeTaskWorktrees.ts`: add success-only, deepest-first cleanup

Old:

```ts
export function removeWorktreeAndBranch(
    repoRoot: string,
    worktreePath: string,
    branchName: string,
): void {
    git(repoRoot, "worktree", "remove", worktreePath, "--force");
    git(repoRoot, "branch", "-D", branchName);
}
```

New (keep the existing helper and add the higher-level helper):

```ts
function deleteLocalBranchIfPresent(repoRoot: string, branchName: string): void {
    try {
        git(repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`);
    } catch {
        return; // idempotent after a partially completed prior cleanup
    }
    git(repoRoot, "branch", "-D", branchName);
}

export type SourceBranchCleanupTarget = {
    checkoutPath: string;
    depth: number;
};

export function removeTaskWorktreeAndBranches(
    repoRoot: string,
    worktreePath: string,
    branchName: string,
    sourceSubmodules: SourceBranchCleanupTarget[],
): void {
    // Close has already succeeded. Delete canonical source-submodule refs
    // deepest-first, while the root task worktree remains available for inspection.
    for (const target of [...sourceSubmodules].sort((a, b) => b.depth - a.depth)) {
        deleteLocalBranchIfPresent(target.checkoutPath, branchName);
    }

    // Root worktree and root task branch are always the final cleanup operation.
    removeWorktreeAndBranch(repoRoot, worktreePath, branchName);
}
```

If any submodule deletion fails, the helper throws before root removal. The task is already merged and closed, so the workflow reports a cleanup warning and leaves the root worktree available for manual/idempotent cleanup.

### `skills/tackle-tasks/task.workflow.js`: invoke branch cleanup only after close

Old:

```js
const { mergeTaskDeepestFirst, removeWorktreeAndBranch } = await import(
  pathToFileURL(join(repoRoot, 'scripts/mergeTaskWorktrees.ts')).href
)
...
const manifest = { repositoryManifest: { ...ARGS.repositoryManifest, ... }, ... }
const rootOccurrence = manifest.repositoryManifest.occurrences
  .find((o) => o.occurrenceId === '')
...
const report = mergeTaskDeepestFirst(repoRoot, manifest)
...
if (!closeResult.closed.includes(N)) {
  return { status: 'merged-but-not-closed', ... }
}
try {
  removeWorktreeAndBranch(mainRepoRoot, repoRoot, branch)
} catch (error) {
  return { ...report, mergedCommitHash, closed: closeResult.closed, cleanupWarning: ... }
}
```

New:

```js
const { mergeTaskDeepestFirst, removeTaskWorktreeAndBranches } = await import(
  pathToFileURL(join(repoRoot, 'scripts/mergeTaskWorktrees.ts')).href
)
...
const manifest = { repositoryManifest: { ...ARGS.repositoryManifest, ... }, ... }
const rootOccurrence = manifest.repositoryManifest.occurrences
  .find((o) => o.occurrenceId === '')

// Snapshot canonical source paths before mergeTaskDeepestFirst substitutes
// task-worktree checkout paths during repository discovery.
const sourceSubmodules = manifest.repositoryManifest.occurrences
  .filter((occurrence) => occurrence.parentOccurrenceId !== null)
  .map((occurrence) => ({
    checkoutPath: occurrence.checkoutPath,
    depth: occurrence.depth,
  }))

...
const report = mergeTaskDeepestFirst(repoRoot, manifest)
...
if (!closeResult.closed.includes(N)) {
  return { status: 'merged-but-not-closed', ... }
}

try {
  removeTaskWorktreeAndBranches(
    mainRepoRoot,
    repoRoot,
    branch,
    sourceSubmodules,
  )
} catch (error) {
  const cleanupWarning = `failed final branch/worktree cleanup: ${String((error && error.message) || error)}`
  return {
    stage: 'merge', task: N, failedAtStage, ...report,
    mergedCommitHash, closed: closeResult.closed,
    unblocked: closeResult.unblocked, cleanupWarning,
  }
}
```

Do not call the new helper on `blocked` or `merged-but-not-closed` paths.

### Replace the false-positive cleanup test

Old (`tests/mergeTaskWorktrees.test.ts`):

```ts
const report = mergeTaskDeepestFirst(fixture.group.worktree, fixture.discoveryManifest);
assert.equal(report.status, "merged");

// The test currently expects deletion before close.
assert.equal(
    git(fixture.mainSubmodulePath, "branch", "--list", submoduleTaskBranch)
        .includes(submoduleTaskBranch),
    false,
);

// It also supplies root cleanup manually.
removeWorktreeAndBranch(fixture.rootPath, fixture.group.worktree, fixture.group.branch);
```

New primitive-ordering assertion:

```ts
const report = mergeTaskDeepestFirst(fixture.group.worktree, fixture.discoveryManifest);
assert.equal(report.status, "merged");

// Merge alone is not close: the task ref must remain recoverable until close succeeds.
assert.notEqual(
    git(fixture.mainSubmodulePath, "branch", "--list", submoduleTaskBranch).trim(),
    "",
);
```

Add production workflow tests in `tests/taskWorkflowMergeStage.test.ts`:

```ts
test('successful close deletes task-N from root and every source submodule', async () => {
    const fixture = makeNestedSubmoduleWorkflowFixture();
    const result = await runMergeStage(fixture.worktreePath, {
        task: fixture.taskNumber,
        stage: 'merge',
        repositoryManifest: fixture.repositoryManifest,
        sourceRoot: fixture.root,
    });

    assert.equal(result.results[0].status, 'merged');
    assert.equal(existsSync(fixture.worktreePath), false);
    for (const sourcePath of [fixture.root, fixture.childSource, fixture.grandchildSource]) {
        assert.throws(() =>
            git(sourcePath, 'show-ref', '--verify', `refs/heads/task-${fixture.taskNumber}`));
    }
});

test('close failure retains root and every source-submodule task ref', async () => {
    const fixture = makeNestedSubmoduleWorkflowFixture({ closeFails: true });
    const result = await runMergeStage(fixture.worktreePath, {
        task: fixture.taskNumber,
        stage: 'merge',
        repositoryManifest: fixture.repositoryManifest,
        sourceRoot: fixture.root,
    });

    assert.equal(result.results[0].status, 'merged-but-not-closed');
    assert.equal(existsSync(fixture.worktreePath), true);
    for (const sourcePath of [fixture.root, fixture.childSource, fixture.grandchildSource]) {
        assert.doesNotThrow(() =>
            git(sourcePath, 'show-ref', '--verify', `refs/heads/task-${fixture.taskNumber}`));
    }
});
```

Neither production workflow test may call `git branch -D`, `removeWorktreeAndBranch`, or `removeTaskWorktreeAndBranches` itself. The successful workflow must perform all cleanup; the close-failure workflow must perform none.

## C86-13 — identify typecheck failures and exercise the production stage

Task 178 correctly threads `typecheckCommand` into the tail launch and runs it before the complete suite in every parent/submodule rebase-test layer. The finding remains partially open because typecheck and test-suite failures both return generic `tests-failed`, and retry exhaustion reports only `layer still red after MAX_REBASE_FIX_ROUNDS`. The required test also substitutes shell `false` at low-level helpers for a real type error through `task.workflow.js`.

### `scripts/mergeTaskWorktrees.ts`: retain which verification command failed

Old outcome types:

```ts
export type SubmoduleLayerOutcome =
    | ...
    | { occurrenceId: string; checkoutPath: string; status: "tests-failed"; testOutput: string }
    | ...;

export type ParentRebaseOutcome =
    | ...
    | { status: "tests-failed"; testOutput: string }
    | ...;
```

New:

```ts
export type FailedCheck = "typecheck" | "complete-suite";

export type SubmoduleLayerOutcome =
    | ...
    | {
          occurrenceId: string;
          checkoutPath: string;
          status: "tests-failed";
          failedCheck: FailedCheck;
          testOutput: string;
      }
    | ...;

export type ParentRebaseOutcome =
    | ...
    | {
          status: "tests-failed";
          failedCheck: FailedCheck;
          testOutput: string;
      }
    | ...;
```

Old typecheck catches:

```ts
try {
    execSync(typecheckCommand, { cwd: checkoutPath, ... });
} catch (error) {
    return {
        occurrenceId,
        checkoutPath,
        status: "tests-failed",
        testOutput: testFailureOutput(error),
    };
}
```

New (apply in both submodule and parent functions):

```ts
try {
    execSync(typecheckCommand, { cwd: checkoutPath, ... });
} catch (error) {
    return {
        occurrenceId,
        checkoutPath,
        status: "tests-failed",
        failedCheck: "typecheck",
        testOutput: testFailureOutput(error),
    };
}
```

For the parent return, omit `occurrenceId`/`checkoutPath` as required by `ParentRebaseOutcome`.

Old complete-suite catches:

```ts
return {
    occurrenceId,
    checkoutPath,
    status: "tests-failed",
    testOutput: testFailureOutput(error),
};
```

New (apply in both submodule and parent functions):

```ts
return {
    occurrenceId,
    checkoutPath,
    status: "tests-failed",
    failedCheck: "complete-suite",
    testOutput: testFailureOutput(error),
};
```

Update existing low-level assertions for suite failures to require `failedCheck === "complete-suite"`; typecheck-helper assertions must require `failedCheck === "typecheck"`.

### `skills/tackle-tasks/task.workflow.js`: include the failed check in `lastFailure`

Old submodule retry ceiling:

```js
if (consumeFixRound(occurrenceId) > MAX_REBASE_FIX_ROUNDS) {
  return {
    stage: 'rebase-test', task: N, status: 'blocked',
    lastFailure: 'layer still red after MAX_REBASE_FIX_ROUNDS',
    occurrenceId, fenceViolations,
  }
}
```

New:

```js
if (consumeFixRound(occurrenceId) > MAX_REBASE_FIX_ROUNDS) {
  return {
    stage: 'rebase-test', task: N, status: 'blocked',
    lastFailure: `${stopped.failedCheck} still red after MAX_REBASE_FIX_ROUNDS`,
    failedCheck: stopped.failedCheck,
    occurrenceId, fenceViolations,
  }
}
```

Old parent retry ceiling:

```js
if (consumeFixRound('') > MAX_REBASE_FIX_ROUNDS) {
  return {
    stage: 'rebase-test', task: N, status: 'blocked',
    lastFailure: 'layer still red after MAX_REBASE_FIX_ROUNDS',
    occurrenceId: '', fenceViolations,
  }
}
```

New:

```js
if (consumeFixRound('') > MAX_REBASE_FIX_ROUNDS) {
  return {
    stage: 'rebase-test', task: N, status: 'blocked',
    lastFailure: `${parentOutcome.failedCheck} still red after MAX_REBASE_FIX_ROUNDS`,
    failedCheck: parentOutcome.failedCheck,
    occurrenceId: '', fenceViolations,
  }
}
```

Keep `tests-failed` as the shared retryable status so the existing fix-agent loop still handles both failures; `failedCheck` supplies the diagnostic distinction.

### Replace the helper-only false-command test with a production-stage type error

Old:

```ts
const outcome = rebaseParentOntoSourceAndTest(
    "root",
    group.worktree,
    sourceBranch,
    [],
    emptyResolutionManifest(),
    false,
    "false",
);
assert.equal(outcome.status, "tests-failed");
```

New workflow-level regression in `tests/taskWorkflowMergeStage.test.ts`:

```ts
test('rebase-test blocks on a real type error even when the complete suite passes', async () => {
    const fixture = makeRootWithWorktree(9013);
    const tsc = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');

    writeFileSync(join(fixture.root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
        include: ['api.ts', 'use.ts'],
    }));
    writeFileSync(join(fixture.root, 'api.ts'), 'export const value: string = "ok"\n');
    writeFileSync(join(fixture.root, 'use.ts'), 'import { value } from "./api"\nconst expected: string = value\n');
    writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({
        scripts: {
            test: `node -e "require('fs').writeFileSync('suite-ran.txt','yes')"`,
        },
    }));
    git(fixture.root, 'add', 'tsconfig.json', 'api.ts', 'use.ts', 'package.json');
    git(fixture.root, 'commit', '-m', 'add passing typed base');

    // Recreate/advance the task worktree from this typed base, then give it an unrelated task commit.
    resetFixtureTaskWorktreeToSource(fixture);
    writeFileSync(join(fixture.worktreePath, 'task-only.txt'), 'task change\n');
    git(fixture.worktreePath, 'add', 'task-only.txt');
    git(fixture.worktreePath, 'commit', '-m', 'task change');

    // Source moves incompatibly. Rebase is clean, npm test would pass, but tsc must fail.
    writeFileSync(join(fixture.root, 'api.ts'), 'export const value: number = 1\n');
    git(fixture.root, 'commit', '-am', 'incompatible source API');
    const sourceHead = git(fixture.root, 'rev-parse', 'HEAD');

    const envelope = await runMergeStage(fixture.worktreePath, {
        task: fixture.taskNumber,
        stage: 'rebase-test',
        repositoryManifest: refreshManifestBase(fixture.repositoryManifest, sourceHead),
        sourceRoot: fixture.root,
        typecheckCommand: `${JSON.stringify(tsc)} --noEmit`,
        maxRebaseFixRounds: 0,
    });
    const consumed = consumeTaskWorkflowResult(createMergeQueueAtRebase(fixture.taskNumber), envelope);

    assert.equal(consumed.kind, 'queue');
    if (consumed.kind !== 'queue') assert.fail('expected queue result');
    const report = buildMergeReport(consumed.queue);
    assert.match(report.unmerged[0]!.lastFailure, /typecheck/i);
    assert.equal(existsSync(join(fixture.worktreePath, 'suite-ran.txt')), false);
    assert.equal(git(fixture.root, 'rev-parse', 'HEAD'), sourceHead);
    const rebasedTaskHead = git(fixture.worktreePath, 'rev-parse', 'HEAD');
    assert.throws(() =>
        git(fixture.root, 'merge-base', '--is-ancestor', rebasedTaskHead, 'main'));
});
```

Adapt the fixture helper names to the test file's real helpers rather than adding duplicate Git setup. Once C86-06 is implemented, use its consumer as shown so this also verifies the real envelope-to-queue failure reason. Until then, the central assertions are that the real stage is `blocked`, `lastFailure` names `typecheck`, the passing suite cannot mask the type error, and the source branch did not merge the task.

Keep one low-level submodule case, but make it a real typecheck command (or a controlled command labeled as such), assert `stoppedAt.failedCheck === "typecheck"`, and assert the complete-suite marker was never written.

## C86-14 — make merge-commit persistence no-guess and lifecycle-complete

Task 179 correctly records `refs/taskTools/merged-commits/task-N` during a normal merge and its new test proves a close-failure retry does not archive a later source tip when that ref is intact. It remains incomplete in two ways:

1. The no-op path still uses `recordedCommit ?? currentSourceTip`, recreating the original corruption after a crash between the source merge and `update-ref`.
2. The durable refs are never deleted after a successful close, leaking one ref per task and repository layer.

The fix must also keep two different OIDs separate on a retry: the historical merge commit used for archival and the current source tip used to propagate a child gitlink into its parent. A later task may have advanced a source submodule after this task's recorded merge.

### `scripts/mergeTaskWorktrees.ts`: add a write-ahead merge intent

Old:

```ts
function mergedCommitRefName(operationBranch: string): string {
    return `refs/taskTools/merged-commits/${operationBranch}`;
}

function recordMergedCommit(repoRoot: string, operationBranch: string, oid: string): void {
    git(repoRoot, "update-ref", mergedCommitRefName(operationBranch), oid);
}
```

New:

```ts
function mergedCommitRefName(operationBranch: string): string {
    return `refs/taskTools/merged-commits/${operationBranch}`;
}

function mergeIntentRefName(operationBranch: string): string {
    return `refs/taskTools/merge-intents/${operationBranch}`;
}

function recordMergeIntent(
    repoRoot: string,
    operationBranch: string,
    operationOid: string,
): void {
    git(repoRoot, "update-ref", mergeIntentRefName(operationBranch), operationOid);
}

function clearMergeIntent(repoRoot: string, operationBranch: string): void {
    git(repoRoot, "update-ref", "-d", mergeIntentRefName(operationBranch));
}

function recordMergedCommit(
    repoRoot: string,
    operationBranch: string,
    mergedOid: string,
): void {
    git(repoRoot, "update-ref", mergedCommitRefName(operationBranch), mergedOid);
}

function readOptionalRef(repoRoot: string, refName: string): string | null {
    try {
        return git(repoRoot, "rev-parse", "--verify", refName).trim();
    } catch {
        return null;
    }
}
```

The intent is written before invoking the source merge. If the process dies after Git lands the merge but before `recordMergedCommit`, the next run sees the intent and refuses to guess. On a successful merge, write the merged-commit ref before clearing the intent.

### `scripts/mergeTaskWorktrees.ts`: keep operational and archival OIDs separate

Old:

```ts
export type MergeLayerOutcome =
    | { occurrenceId: string; checkoutPath: string; status: "no-op"; oid: string }
    | { occurrenceId: string; checkoutPath: string; status: "merged"; oid: string };
```

New:

```ts
export type MergeLayerOutcome =
    | {
          occurrenceId: string;
          checkoutPath: string;
          status: "no-op";
          // Current source tip: used only for child-gitlink propagation.
          oid: string;
          // Historical task merge commit: used for close/archive, null for an untouched layer.
          mergedCommitOid: string | null;
      }
    | {
          occurrenceId: string;
          checkoutPath: string;
          status: "merged";
          oid: string;
          mergedCommitOid: string;
      };
```

Extend `MergeTaskWalkReport` with a typed refusal:

```ts
| {
      status: "merge-record-missing";
      completedLayers: MergeLayerOutcome[];
      occurrenceId: string;
      checkoutPath: string;
      stage: "merge";
      failureReason: string;
  };
```

### `scripts/mergeTaskWorktrees.ts`: replace the no-op fallback

Old:

```ts
if (skippedOccurrenceIds.has(occurrence.occurrenceId)) {
    const oid = readRecordedMergedCommit(sourceCheckoutPath, occurrence.operationBranch)
        ?? git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
    sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
    completedLayers.push({
        occurrenceId: displayId,
        checkoutPath: occurrence.checkoutPath,
        status: "no-op",
        oid,
    });
    ...
    continue;
}
```

New:

```ts
if (skippedOccurrenceIds.has(occurrence.occurrenceId)) {
    const currentSourceOid = git(
        sourceCheckoutPath,
        "rev-parse",
        occurrence.baseBranch,
    ).trim();
    const mergedCommitOid = readOptionalRef(
        sourceCheckoutPath,
        mergedCommitRefName(occurrence.operationBranch),
    );
    const pendingIntent = readOptionalRef(
        sourceCheckoutPath,
        mergeIntentRefName(occurrence.operationBranch),
    );

    // An intent without a completed record means the prior process may have died
    // after the source merge. The current source tip is not proof of this task's hash.
    // The root must always have a recorded merge before it can be archived.
    if (pendingIntent !== null || (occurrence.parentOccurrenceId === null && mergedCommitOid === null)) {
        return {
            status: "merge-record-missing",
            completedLayers,
            occurrenceId: displayId,
            checkoutPath: occurrence.checkoutPath,
            stage: "merge",
            failureReason:
                `task branch "${occurrence.operationBranch}" is already merged in `
                + `occurrence "${displayId}", but its merge-time commit record is missing; `
                + `refusing to guess from the current ${occurrence.baseBranch} tip`,
        };
    }

    // Propagate the current child source tip, not this task's older merge commit.
    sourceTipByOccurrenceId.set(occurrence.occurrenceId, currentSourceOid);
    completedLayers.push({
        occurrenceId: displayId,
        checkoutPath: occurrence.checkoutPath,
        status: "no-op",
        oid: currentSourceOid,
        mergedCommitOid,
    });
    // C86-10 retains task refs until successful close.
    continue;
}
```

An untouched submodule may legitimately have no merge record, so `mergedCommitOid` can be null there. The root cannot be closed without a recorded merge commit. A surviving intent is always an error because it marks an interrupted merge protocol.

### `scripts/mergeTaskWorktrees.ts`: record around each actual source merge

Old submodule shape:

```ts
const result = mergeStepOperations.mergeSubmodule(...);
if (!result.merged) return { status: "submodule-conflicted", ... };
const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
recordMergedCommit(sourceCheckoutPath, occurrence.operationBranch, oid);
sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
completedLayers.push({ occurrenceId: displayId, checkoutPath: occurrence.checkoutPath, status: "merged", oid });
```

New (apply the same sequence around the root merge):

```ts
const operationOid = git(
    occurrence.checkoutPath,
    "rev-parse",
    occurrence.operationBranch,
).trim();
recordMergeIntent(sourceCheckoutPath, occurrence.operationBranch, operationOid);

const result = mergeStepOperations.mergeSubmodule(...);
if (!result.merged) {
    clearMergeIntent(sourceCheckoutPath, occurrence.operationBranch);
    return { status: "submodule-conflicted", ... };
}

const oid = git(sourceCheckoutPath, "rev-parse", occurrence.baseBranch).trim();
recordMergedCommit(sourceCheckoutPath, occurrence.operationBranch, oid);
clearMergeIntent(sourceCheckoutPath, occurrence.operationBranch);
sourceTipByOccurrenceId.set(occurrence.occurrenceId, oid);
completedLayers.push({
    occurrenceId: displayId,
    checkoutPath: occurrence.checkoutPath,
    status: "merged",
    oid,
    mergedCommitOid: oid,
});
```

Do not clear the intent in a broad `finally`: a thrown process/recording failure must leave evidence that prevents a later no-op retry from guessing.

### `skills/tackle-tasks/task.workflow.js`: archive only `mergedCommitOid`

Old:

```js
const rootLayer = report.completedLayers.find((layer) => layer.occurrenceId === 'root')
const mergedCommitHash = rootLayer.oid
```

New:

```js
const rootLayer = report.completedLayers.find((layer) => layer.occurrenceId === 'root')
const mergedCommitHash = rootLayer?.mergedCommitOid
if (typeof mergedCommitHash !== 'string' || mergedCommitHash.length === 0) {
  return {
    stage: 'merge', task: N, status: 'blocked',
    lastFailure: 'root merge-time commit record is missing; refusing to archive the current source tip',
  }
}
```

The existing generic `report.status !== 'merged'` path will already turn `merge-record-missing` into a blocked result with its concrete `failureReason` once C86-07's non-null normalization is applied.

### Delete persistence refs only after close

Add this beside the ref helpers:

```ts
export function deleteTaskMergePersistence(
    repoRoot: string,
    operationBranch: string,
): void {
    git(repoRoot, "update-ref", "-d", mergedCommitRefName(operationBranch));
    git(repoRoot, "update-ref", "-d", mergeIntentRefName(operationBranch));
}
```

Fold it into C86-10's final all-layer cleanup traversal. After `closeTasks` confirms `closed.includes(N)`, delete merge persistence in every canonical source submodule and root, then remove the root worktree/root task branch last. A failure remains a post-close `cleanupWarning`. On `merged-but-not-closed`, retain all persistence refs for retry.

### Regression tests

Keep task 179's new close-failure/source-advance/retry test; it correctly covers the intact-record path. Add:

```ts
test('retry refuses to guess when merge intent exists but merge record is missing', async () => {
    const fixture = makeRootWithWorktree(9014);
    seedTaskFiles(fixture.root, 9014);
    commitTaskChange(fixture.worktreePath);

    // Simulate interruption after the source merge but before recordMergedCommit.
    const taskOid = git(fixture.worktreePath, 'rev-parse', 'task-9014');
    git(fixture.root, 'update-ref', 'refs/taskTools/merge-intents/task-9014', taskOid);
    git(fixture.root, 'merge', '--no-ff', 'task-9014', '-m', 'merge task 9014');
    advanceSourceWithAnotherTask(fixture.root);

    const envelope = await runMergeStage(fixture.worktreePath, {
        task: 9014,
        stage: 'merge',
        repositoryManifest: fixture.repositoryManifest,
        sourceRoot: fixture.root,
    });
    const consumed = consumeTaskWorkflowResult(createMergeQueueAtMerge(9014), envelope);

    assert.equal(consumed.kind, 'queue');
    if (consumed.kind !== 'queue') assert.fail('expected queue result');
    const report = buildMergeReport(consumed.queue);
    assert.match(report.unmerged[0]!.lastFailure, /record is missing; refusing to guess/);
    assert.equal(readCompleted(fixture.root).some((task) => task.taskNumber === 9014), false);
});
```

Add a nested-layer regression where task A's submodule merge is recorded, task B later advances that source submodule, and A retries its parent. Assert the parent records B's current submodule source tip (`oid`) while A's historical `mergedCommitOid` remains unchanged.

Finally, extend C86-10's cleanup tests:

- Successful close: both `refs/taskTools/merged-commits/task-N` and `refs/taskTools/merge-intents/task-N` are absent in root and every canonical source submodule.
- Close failure: the merged-commit refs remain so the retry can archive the original hash.

## C86-15 — exercise the complete production-shaped orchestration matrix

Task 180 added root-success, submodule-success, and submodule-conflict tests, but the tests still assemble the successful part of the pipeline themselves. They call the worktree primitive instead of production preparation, attach `operationBranch` in the fixture, skip the plan/implement notification and approval gate, manually decode tail envelopes, and inject a made-up conflict reason. The success cases only check the archive and then delete the worktree in `finally`, so a broken close or branch cleanup still passes.

Apply C86-01, C86-05, C86-06, C86-08, and C86-10 before this section. This matrix must exercise those production boundaries rather than compensating for them in its fixture.

### `tests/runMergePhase.test.ts`: use actual preparation output

Old:

```ts
import {
    attachOperationBranch,
    createWorktreeForGroup,
    loadRepositoryManifest,
} from "../scripts/prepareTasks.ts";
import { currentBranchName } from "../scripts/repositoryBranches.ts";

const worktreePath = createWorktreeForGroup(root, {
    groupId: taskNumber,
    taskNumbers: [taskNumber],
    filePaths: [],
    scope: "unknown",
});
const operationBranch = currentBranchName(worktreePath);
// ...write task state after creating the worktree...
const manifest = loadRepositoryManifest(root);
const repositoryManifest = {
    ...manifest,
    occurrences: attachOperationBranch(manifest.occurrences, operationBranch),
};
```

New:

```ts
import { buildWorkflowArguments, loadRepositoryManifest }
    from "../scripts/prepareTasks.ts";

const task: TaskRecord = {
    taskNumber,
    title: "fixture",
    files: ownedFiles,
    blockedBy: [],
};

// Production preparation reads authoritative state before it creates the worktree.
mkdirSync(join(root, ".taskTools"), { recursive: true });
writeFileSync(join(root, ".taskTools", "tasks.json"), `${JSON.stringify([task])}\n`);
writeFileSync(join(root, ".taskTools", "completedTasks.json"), "[]\n");
git(root, "add", ".taskTools/tasks.json", ".taskTools/completedTasks.json");
git(root, "commit", "-q", "-m", "seed task state");

// Give the fixture the same prerequisite as the real prepareTasks CLI.
const origin = mkdtempSync(join(tmpdir(), "task-86-e2e-origin-"));
git(origin, "init", "-q", "--bare");
git(root, "remote", "add", "origin", origin);

const prepared = buildWorkflowArguments(root, "npx tsc --noEmit", [task]);
const group = prepared.groups[0]!;
const worktreePath = group.worktree;
const repositoryManifest = loadRepositoryManifest(root);

// Deliberately assert that the prepare result is still discovery-shaped. The
// workflow, not the test, derives task-N for each occurrence.
assert.equal(
    repositoryManifest.occurrences.every((occurrence) => occurrence.operationBranch === ""),
    true,
);
```

For maximum CLI fidelity, run `scripts/prepareTasks.ts` from `root`, parse its stdout, and use its `groups`, `repositoryManifest`, `typecheckCommand`, and `repo` fields directly. Do not call `attachOperationBranch` anywhere in these three tests. The repeated `No such remote 'origin'` diagnostics in task 180's passing test run are evidence that its fixtures do not satisfy the real prepare entry point.

### Drive notification and approval instead of starting at an approved queue

Old:

```ts
let queue = createMergeQueue();
queue = enqueueApprovedTask(queue, taskNumber);

const step = nextQueueStep(queue);
const result = await runTaskWorkflowStage(worktreePath, {
    task: taskNumber,
    stage: step!.stage,
    repositoryManifest,
});
const outcome = result.results[0] as { status: string };
queue = recordStageOutcome(queue, taskNumber, "rebase-test", { status: "success" });
```

New:

```ts
let queue = createMergeQueue();

// The C86-01 harness makes the scripted implementer edit and commit inside
// group.worktree. This is the real plan+implement completion notification.
const planNotification = await runTaskWorkflowStage(group.worktree, {
    task: taskNumber,
    typecheckCommand: prepared.typecheckCommand,
    worktree: group.worktree,
    sourceRoot: prepared.repo,
    repositoryManifest,
}, scriptedPlanningAndImplementationAgent(group.worktree));

const consumedPlan = consumeTaskWorkflowResult(queue, planNotification);
assert.equal(consumedPlan.kind, "approval");
if (consumedPlan.kind !== "approval") assert.fail("expected approval notification");
assert.equal(consumedPlan.approval.status, "done");
assert.deepEqual(consumedPlan.approval.fenceViolations, []);

// This explicit decision is the gate. Rejection must have a companion case
// proving that it does not enqueue; approval enters the queue immediately.
const gateDecision: "approve" | "reject" = "approve";
if (gateDecision === "approve") {
    queue = enqueueApprovedTask(queue, consumedPlan.approval.taskNumber);
}

while (true) {
    const action = nextQueueAction(queue, { any: false, tail: false });
    if (action.kind === "report") break;
    if (action.kind === "begin-next-lap") {
        queue = beginNextLap(queue);
        continue;
    }
    if (action.kind === "wait") assert.fail("no workflow is outstanding");

    const notification = await runTaskWorkflowStage(group.worktree, {
        task: action.step.taskNumber,
        stage: action.step.stage,
        typecheckCommand: prepared.typecheckCommand,
        repositoryManifest,
        worktree: group.worktree,
        sourceRoot: prepared.repo,
    }, tailAgent);
    const consumed = consumeTaskWorkflowResult(queue, notification);
    assert.equal(consumed.kind, "queue");
    if (consumed.kind !== "queue") assert.fail("expected tail notification");
    queue = consumed.queue;
}
```

`consumeTaskWorkflowResult` and `nextQueueAction` are the executable C86-06/C86-05 adapters. The generated brief must call those same functions, so these tests cover production behavior rather than a second, test-only interpretation of the prose.

### Feed the real submodule conflict into the queue

Old:

```ts
const rebaseTestOutcome = rebaseTestResult.results[0] as { status: string };
assert.notEqual(rebaseTestOutcome.status, "green");
queue = recordStageOutcome(queue, taskNumber, "rebase-test", {
    status: "failure",
    reason: "submodule rebase conflicted: seed.txt",
});

assert.deepEqual(buildMergeReport(queue).unmerged, [{
    taskNumber,
    lastFailure: "submodule rebase conflicted: seed.txt",
    terminalReason: "zero-merge lap ended the queue",
}]);
```

New:

```ts
const consumed = consumeTaskWorkflowResult(queue, rebaseTestResult);
assert.equal(consumed.kind, "queue");
if (consumed.kind !== "queue") assert.fail("expected queue notification");
queue = consumed.queue;

const report = buildMergeReport(queue);
assert.equal(report.unmerged.length, 1);
assert.equal(report.unmerged[0]!.taskNumber, taskNumber);
assert.match(report.unmerged[0]!.lastFailure, /submodule|vendor/i);
assert.match(report.unmerged[0]!.lastFailure, /conflict|unresolved/i);
```

Do not merely assert `status !== "green"`: that lets an unrelated exception satisfy the conflict case. The report must carry the exact nonempty `lastFailure` returned by the real workflow envelope.

### Assert the close and cleanup contract before fixture teardown

Old:

```ts
const archived = JSON.parse(readFileSync(completedPath, "utf8"));
assert.deepEqual(archived.map((task) => task.taskNumber), [taskNumber]);
} finally {
    rmSync(worktreePath, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
}
```

New root-success assertions:

```ts
assert.deepEqual(readTasks(root), []);
assert.equal(readCompleted(root).some((task) => task.taskNumber === taskNumber), true);
assert.equal(git(root, "show", "main:taskfile.txt"), "task change");
assert.equal(existsSync(worktreePath), false);
assert.throws(() => git(root, "show-ref", "--verify", `refs/heads/task-${taskNumber}`));
```

New submodule-success assertions:

```ts
assert.equal(git(join(root, "vendor"), "show", "main:vendor-new.txt"), "vendor new");
assert.equal(
    git(root, "rev-parse", "main:vendor"),
    git(join(root, "vendor"), "rev-parse", "main"),
);
assert.equal(existsSync(worktreePath), false);
for (const repo of [root, join(root, "vendor")]) {
    assert.throws(() => git(repo, "show-ref", "--verify", `refs/heads/task-${taskNumber}`));
}
```

New submodule-conflict assertions:

```ts
assert.equal(readTasks(root).some((task) => task.taskNumber === taskNumber), true);
assert.equal(readCompleted(root).some((task) => task.taskNumber === taskNumber), false);
assert.equal(existsSync(worktreePath), true);
assert.doesNotThrow(() => git(root, "show-ref", "--verify", `refs/heads/task-${taskNumber}`));
assert.doesNotThrow(() => git(join(root, "vendor"), "show-ref", "--verify", `refs/heads/task-${taskNumber}`));
```

The `finally` block may remove fixture directories after these assertions, but manual deletion cannot stand in for a successful workflow cleanup. A failed assertion must expose a retained worktree or leaked branch before teardown runs.

The three cases pass only when their event traces contain the full sequence:

```ts
assert.deepEqual(trace, [
    "prepare",
    "notification:plan+implement",
    "gate:approve",
    "notification:rebase-test",
    // success cases only:
    "notification:merge",
    "close",
    "cleanup",
]);
```

For the conflict case, the trace ends after `notification:rebase-test`, and the retained-state assertions replace `close`/`cleanup`.

## C86-17 — remove the last internal renumbering drift and test document identity

Task 183 renamed all four files and its filename drift check passes, but `plans/task-163-plan.md` still describes the spec's bottom section as a historical note about task 156. The section now correctly identifies task 162, and task 156 no longer exists. This leaves exactly the internal-number drift that task 183's goal required it to remove. The new test checks filenames only, so it cannot detect the stale number inside a renamed document.

### `plans/task-163-plan.md`: correct the stale internal reference

Old:

```md
No other edits to this file — the "Bug found while grilling" section at the
bottom (lines 275–291) is left as-is: it is a historical note about task 156
that this task does not touch.
```

New:

```md
No other edits to this file — the "Bug found while grilling" section at the
bottom (lines 275–291) is left as-is: it is a historical note about task 162
that this task does not touch.
```

### `tests/planFileNumbering.test.ts`: cover task identities inside the renamed files

Old:

```ts
import { readdirSync } from "node:fs";

test("every plans/brief-N.md and plans/task-N-plan.md names a task number that exists in tasks.json or completedTasks.json", () => {
  assert.deepEqual(driftingPlanFiles(), []);
});
```

New:

```ts
import { readFileSync, readdirSync } from "node:fs";

test("every plans/brief-N.md and plans/task-N-plan.md names a task number that exists in tasks.json or completedTasks.json", () => {
  assert.deepEqual(driftingPlanFiles(), []);
});

test("renumbered closing-chain files contain their current task numbers", () => {
  const renumbered = [
    ["brief-162.md", 162],
    ["task-162-plan.md", 162],
    ["brief-163.md", 163],
    ["task-163-plan.md", 163],
  ] as const;

  for (const [file, taskNumber] of renumbered) {
    const body = readFileSync(join(repoRoot, "plans", file), "utf8");
    assert.match(body, new RegExp(`^# Task ${taskNumber}\\b`), file);
    assert.doesNotMatch(body, /\b[Tt]ask (?:156|157)\b/, file);
  }
});
```

Keep the existing filename-to-task-record check: it guards the general convention. The added targeted check covers the four files from this renumber and fails if either the identity header or an obsolete 156/157 reference returns.

## Completion check

After implementing these replacements, the focused acceptance run should include at least:

```sh
npx tsc --noEmit
node --test \
  tests/addTaskFiles.test.ts \
  tests/closeTasks.test.ts \
  tests/planFileNumbering.test.ts \
  tests/runMergePhase.test.ts \
  tests/tackleTasksBrief.test.ts \
  tests/taskWorkflowMergeStage.test.ts
```

The fixes are complete only if the tests exercise real prepared worktrees, complete workflow envelopes, and actual concurrent child processes rather than supplying the missing production behavior from the test harness.
