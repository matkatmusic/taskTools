# Task 86 Codex audit fixes — remaining items after round 1

The round-1 implementation resolved every audited finding except these four:

- C86-01 — fully enforce planner worktree isolation
- C86-08 — make every task-state writer use one canonical lock and atomic publication
- C86-14 — add the missing nested retry regression for merge-time OIDs
- C86-15 — complete the production-shaped orchestration matrix

The old/new snippets below target commit `e9caf9b` plus the current working-tree correction to `plans/task-163-plan.md`. Line numbers on each Old label identify the current code being replaced; ellipses mean to retain surrounding code unchanged.

## C86-01 — fully enforce planner worktree isolation

The planner and implementer instructions are now rooted in the prepared worktree, and a worker cannot report `done` without committing there. Two gaps remain: the planner's final prohibition contradicts its required brief/guide reads, and the plan-file guard trusts the path returned by the agent rather than the workflow's expected worktree path.

### `skills/tackle-tasks/task.workflow.js`: preserve the explicit non-source read exceptions

Old — current `skills/tackle-tasks/task.workflow.js:141-144`:

```js
Return {task: ${t.number}, status, planFile: "${t.planFile}", question, missingFiles}.
You are forbidden to edit any file other than ${t.planFile}; to read a file outside
the absolute owned paths; to leave a decision for the implementer; or to write a plan step
whose exact target you did not read.`
```

New:

```js
Return {task: ${t.number}, status, planFile: "${t.planFile}", question, missingFiles}.
You are forbidden to edit any file other than ${t.planFile}; to read a task source
file outside the absolute owned paths; to leave a decision for the implementer; or to
write a plan step whose exact target you did not read. The absolute brief and plan paths
above, plus ~/.claude/guides/planning.md, are the only non-source read exceptions.`
```

This keeps the ownership fence without simultaneously requiring and forbidding the brief and planning guide.

### `skills/tackle-tasks/task.workflow.js`: validate the expected plan path, not an agent-controlled path

Old — current `skills/tackle-tasks/task.workflow.js:391-401`:

```js
const rejectPlannedWithoutPlanFile = async (planResult) => {
  if (planResult.status !== 'planned') return planResult
  const { existsSync } = await import('node:fs')
  if (existsSync(planResult.planFile)) return planResult
  return {
    ...planResult,
    status: 'needs-clarification',
    question: 'planner reported status "planned" but did not write the plan file inside the task worktree',
  }
}
```

New:

```js
const rejectPlannedWithoutExpectedPlanFile = async (planResult, expectedPlanFile) => {
  if (planResult.status !== 'planned') return planResult
  const { existsSync } = await import('node:fs')
  if (planResult.planFile === expectedPlanFile && existsSync(expectedPlanFile)) {
    return planResult
  }
  return {
    ...planResult,
    status: 'needs-clarification',
    planFile: expectedPlanFile,
    question:
      `planner reported status "planned" without writing the expected task-worktree plan: ${expectedPlanFile}`,
  }
}
```

Old call sites — current `skills/tackle-tasks/task.workflow.js:421` and `skills/tackle-tasks/task.workflow.js:447`:

```js
planResult = await rejectPlannedWithoutPlanFile(planResult)
```

New:

```js
planResult = await rejectPlannedWithoutExpectedPlanFile(
  planResult,
  preparedTask.planFile,
)
```

### `tests/taskWorkflowPlanImplementStage.test.ts`: reject an ambient existing plan

Add a negative case beside the existing “done without committing” test:

```ts
test('plan+implement rejects a planner that returns an existing plan outside the task worktree', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const task = tasks[0]!
  const prepared = buildWorkflowArguments(root, 'true', [task])
  const group = prepared.groups[0]!
  linkScripts(group.worktree)

  try {
    const ambientPlan = join(root, 'plans', `task-${task.taskNumber}-plan.md`)
    mkdirSync(dirname(ambientPlan), { recursive: true })
    writeFileSync(ambientPlan, 'ambient plan\n')
    let verifierOrWorkerRan = false

    const envelope = await runTaskWorkflowAtRealScriptPath({
      task: task.taskNumber,
      stage: 'plan+implement',
      typecheckCommand: prepared.typecheckCommand,
      worktree: group.worktree,
      sourceRoot: root,
    }, async (_prompt, options) => {
      if (options.label.startsWith('plan:')) {
        return {
          task: task.taskNumber,
          status: 'planned',
          planFile: ambientPlan,
          question: '',
          missingFiles: [],
        }
      }
      verifierOrWorkerRan = true
      throw new Error(`unexpected ${options.label}`)
    })

    assert.equal(envelope.results.length, 1)
    assert.equal(envelope.results[0]!.status, 'needs-clarification')
    assert.equal(verifierOrWorkerRan, false)
    assert.equal(existsSync(join(group.worktree, 'plans', `task-${task.taskNumber}-plan.md`)), false)
  } finally {
    rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
```

The existing two-worktree commit test and dishonest-implementer test remain; this new case covers the planner half of the boundary.

## C86-08 — make every task-state writer use one canonical lock and atomic publication

The new lock fixes the demonstrated root-level widen/widen and widen/close races. It is not yet one protocol for the whole repository:

- callers lock the raw `sourceRoot`/`process.cwd()`, although `resolveTaskFiles` may walk upward to a different authoritative root;
- `seedTaskFilesIfAbsent` still uses an unlocked `existsSync`/`writeFileSync` pair;
- `archivePublishedTasks` holds the lock but truncates both JSON files through direct `writeFile` calls;
- `prepareTasks` reads and builds its snapshot before acquiring the lock, then locks only the final write.

### `scripts/taskStateLock.ts`: anchor the lock beside the resolved authoritative task file

Old — current `scripts/taskStateLock.ts:7` and `scripts/taskStateLock.ts:12-22`:

```ts
import { dirname, join } from "node:path";

export function taskStateLockPath(sourceRoot: string): string {
    return join(sourceRoot, ".taskTools", "task-state.lock");
}

export function withTaskStateLock<T>(
    sourceRoot: string,
    action: () => T,
    { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
): T {
    const lockPath = taskStateLockPath(sourceRoot);
    ...
}
```

New:

```ts
import { dirname, join } from "node:path";

// tasksPath has already been resolved by resolveTaskFiles. Root and subdirectory
// invocations that mutate the same tasks.json therefore resolve to the same lock.
export function taskStateLockPath(tasksPath: string): string {
    return join(dirname(tasksPath), "task-state.lock");
}

export function withTaskStateLock<T>(
    tasksPath: string,
    action: () => T,
    { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
): T {
    const lockPath = taskStateLockPath(tasksPath);
    ...
}
```

Keep the existing atomic `openSync(lockPath, "wx")`, timeout, `finally`, and `writeJsonAtomically` implementation.

### `scripts/taskFiles.ts`: expose the authoritative root and lock initialization

Add:

```ts
import { basename, dirname, join } from "node:path";
import { withTaskStateLock, writeJsonAtomically } from "./taskStateLock.ts";

export function taskFilesProjectRoot(pair: TaskFilePair): string {
  const taskDirectory = dirname(pair.tasksPath)
  return basename(taskDirectory) === '.taskTools'
    ? dirname(taskDirectory)
    : taskDirectory
}
```

Old — current `scripts/taskFiles.ts:26-32`:

```ts
export function seedTaskFilesIfAbsent(pair: TaskFilePair): void {
  for (const path of [pair.tasksPath, pair.completedTasksPath]) {
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "[]\n");
  }
}
```

New:

```ts
export function seedTaskFilesIfAbsent(pair: TaskFilePair): void {
  mkdirSync(dirname(pair.tasksPath), { recursive: true })
  withTaskStateLock(pair.tasksPath, () => {
    for (const path of [pair.tasksPath, pair.completedTasksPath]) {
      if (!existsSync(path)) writeJsonAtomically(path, [])
    }
  })
}
```

Drop `writeFileSync` from this file if it has no remaining use.

### Canonicalize every lock caller

Apply this shape to `addTaskFiles`, `closeTasks`, `blockerVerdicts`, `unblockDependents`, `taskArchival`, and `prepareTasks`.

Old — current `scripts/addTaskFiles.ts:68-80`:

```ts
return withTaskStateLock(sourceRoot, () => {
    const pair = resolveTaskFiles(sourceRoot);
    ...
    const argumentsPath = resolveRunArgumentsPath(sourceRoot);
```

New:

```ts
const pair = resolveTaskFiles(sourceRoot)
const authoritativeRoot = taskFilesProjectRoot(pair)
return withTaskStateLock(pair.tasksPath, () => {
    ...
    const argumentsPath = resolveRunArgumentsPath(authoritativeRoot)
```

Old — current `scripts/closeTasks.ts:53-60`:

```ts
return withTaskStateLock(projectRoot, () =>
  closeTasksLocked(taskNumbers, closureNote, projectRoot, commitHashes));
```

New:

```ts
const pair = resolveTaskFiles(projectRoot)
return withTaskStateLock(pair.tasksPath, () =>
  closeTasksLocked(taskNumbers, closureNote, pair, commitHashes))
```

Change `closeTasksLocked` to accept `TaskFilePair` and use it directly rather than resolving again. The CLI and workflow may still pass the source root; only the lock identity must come from the resolved pair.

Old — current `scripts/blockerVerdicts.ts:47-52` and `scripts/unblockDependents.ts:36-42`:

```ts
const sourceRoot = process.cwd();
const { tasksPath } = resolveTaskFiles(sourceRoot);
const result = withTaskStateLock(sourceRoot, () => {
```

New:

```ts
const pair = resolveTaskFiles(process.cwd())
const result = withTaskStateLock(pair.tasksPath, () => {
  const { tasksPath } = pair
```

This is the essential subdirectory fix: every writer that resolves the same `tasksPath` now serializes on the same lock.

### `scripts/taskArchival.ts`: publish atomically and make an archive-first retry idempotent

Old — current `scripts/taskArchival.ts:41-46`, `scripts/taskArchival.ts:57-62`, and `scripts/taskArchival.ts:79-97`:

```ts
export function archivePublishedTasks(
    ...,
    projectRoot: string = process.cwd(),
    writeFile: (path: string, data: string) => void = writeFileSync,
): { archived: number[]; leftOpen: number[] } {
    ...
    archived = withTaskStateLock(projectRoot, (): number[] => {
      const { tasksPath, completedTasksPath } = resolveTaskFiles(projectRoot)
      ...
      for (const { task, commitHashes } of toArchive) {
        completedTasks.push({ ...task, completionDate, commitHashes })
      }
      ...
      writeFile(tasksPath, serializedTasks)
      writeFile(completedTasksPath, serializedCompleted)
```

New shape:

```ts
export function archivePublishedTasks(
    ...,
    projectRoot: string = process.cwd(),
    writeJson: (path: string, value: unknown) => void = writeJsonAtomically,
): { archived: number[]; leftOpen: number[] } {
    const pair = resolveTaskFiles(projectRoot)
    ...
    archived = withTaskStateLock(pair.tasksPath, (): number[] => {
      const tasks = readTaskFile(pair.tasksPath)
      const completedTasks = readTaskFile(pair.completedTasksPath)
      ...
      for (const { task, commitHashes } of toArchive) {
        const record = { ...task, completionDate, commitHashes }
        const existing = completedTasks.findIndex(
          (entry) => entry.taskNumber === task.taskNumber,
        )
        if (existing === -1) completedTasks.push(record)
        else completedTasks[existing] = record
      }
      for (const { index } of [...toArchive].sort((a, b) => b.index - a.index)) {
        tasks.splice(index, 1)
      }

      // Loss-proof order. If the second publication fails, the task exists in
      // both files and a retry overwrites—not duplicates—the archive record.
      writeJson(pair.completedTasksPath, completedTasks)
      writeJson(pair.tasksPath, tasks)
      return toArchive.map(({ task }) => task.taskNumber)
    })
```

Remove the direct-write/rollback block. Update its injected-failure tests to inject an atomic JSON writer and assert the archive-first partial state is safely retryable.

### `scripts/prepareTasks.ts`: build the published snapshot from locked, fresh task bytes

Old — current `scripts/prepareTasks.ts:229-257`:

```ts
const pair = resolveTaskFiles(repoRoot);
const openTasks = readTaskFile(pair.tasksPath);
...
const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, tasks);
const pipelineArguments = { ...workflowArguments, ... };
...
withTaskStateLock(repoRoot, () => writeJsonAtomically(argumentsFile, pipelineArguments));
```

New:

```ts
const pair = resolveTaskFiles(repoRoot)
const openTasks = readTaskFile(pair.tasksPath)
...
const workflowArguments = buildWorkflowArguments(repoRoot, DEFAULT_TYPECHECK_COMMAND, tasks)
const pipelineArguments = { ...workflowArguments, ... }
const argumentsFile = resolveRunArgumentsPath(taskFilesProjectRoot(pair))

withTaskStateLock(pair.tasksPath, () => {
  const latestByNumber = new Map(
    readTaskFile(pair.tasksPath).map((task) => [task.taskNumber, task]),
  )
  for (const group of pipelineArguments.groups) {
    for (const preparedTask of group.tasks) {
      const latest = latestByNumber.get(preparedTask.number)
      if (!latest) {
        throw new Error(
          `prepareTasks: task ${preparedTask.number} changed or closed during preparation`,
        )
      }
      preparedTask.files = declaredFiles(latest)
    }
  }
  writeJsonAtomically(argumentsFile, pipelineArguments)
})
```

This avoids holding the mutex during Git worktree/submodule preparation while ensuring the published `run-arguments.json` reflects the task state at its atomic publication boundary.

### Concurrency regressions

Keep the existing 16-process widening and both widen/close tests. Add:

```ts
test('root and nested-cwd writers use the same authoritative lock', async () => {
  const root = makeProjectRoot()
  const nested = join(root, 'packages', 'child')
  mkdirSync(nested, { recursive: true })
  seedRunArguments(root)

  // Launch half the real addTaskFiles CLI processes with cwd=root and half
  // with cwd=nested. Every process widens the same authoritative task with a
  // unique path.
  await runConcurrentWideners([
    ...writersFrom(root),
    ...writersFrom(nested),
  ])

  assertFullUnionInTasksAndRunArguments(root)
  assert.equal(existsSync(join(nested, '.taskTools', 'task-state.lock')), false)
})
```

Also add:

- concurrent `seedTaskFilesIfAbsent` processes, asserting both files remain valid JSON;
- a preparation race where a locked widener lands before publication and the emitted/file snapshot contains the widened path;
- a workflow invocation without `sourceRoot`, asserting it rejects before changing the source or task worktree;
- an atomic-publication reader test for `archivePublishedTasks`, or an injected second-write failure followed by a successful idempotent retry.

## C86-14 — add the missing nested retry regression for merge-time OIDs

The production no-guess protocol is implemented: merge intents precede real merges, merge-time refs are recorded before intents clear, no-op roots refuse missing records, current source `oid` is distinct from historical `mergedCommitOid`, and persistence is deleted only after close. The remaining gap is the required nested retry test.

### `tests/mergeTaskWorktrees.test.ts`: prove current child propagation does not overwrite historical attribution

The existing tests cover first-pass nested propagation and root close retries separately. Add this combined regression using the existing one-submodule manifest fixture and `defaultMergeStepOperations`.

```ts
test('retry propagates a later child source tip while retaining the task historical child merge oid', () => {
  const fixture = makeSubmoduleManifestFixture()
  const branch = fixture.operationBranch

  // Task A changes the child and records that gitlink in its parent branch.
  commitTaskSubmoduleChange(fixture, 'task-a.txt')

  let failParentOnce = true
  const first = mergeTaskDeepestFirst(fixture.worktreePath, fixture.manifest, {
    ...defaultMergeStepOperations,
    mergeGroup: (...args) => {
      if (failParentOnce) {
        failParentOnce = false
        return {
          merged: false,
          conflictedFilePaths: ['parent.txt'],
          failureReason: 'forced parent failure after child merge',
        }
      }
      return defaultMergeStepOperations.mergeGroup(...args)
    },
  })

  assert.equal(first.status, 'parent-conflicted')
  const firstChild = first.completedLayers.find((layer) => layer.occurrenceId === 'vendor')!
  assert.equal(firstChild.status, 'merged')
  const taskAChildMergeOid = firstChild.mergedCommitOid

  // Task B advances the canonical child source after A's child already merged.
  writeFileSync(join(fixture.sourceSubmodulePath, 'task-b.txt'), 'B\n')
  git(fixture.sourceSubmodulePath, 'add', 'task-b.txt')
  git(fixture.sourceSubmodulePath, 'commit', '-q', '-m', 'task B advances child')
  const taskBChildTip = git(fixture.sourceSubmodulePath, 'rev-parse', 'main')
  assert.notEqual(taskBChildTip, taskAChildMergeOid)

  const retried = mergeTaskDeepestFirst(fixture.worktreePath, fixture.manifest)
  assert.equal(retried.status, 'merged')
  if (retried.status !== 'merged') assert.fail('expected retry to merge')

  const retriedChild = retried.completedLayers.find(
    (layer) => layer.occurrenceId === 'vendor',
  )!
  assert.equal(retriedChild.status, 'no-op')
  assert.equal(retriedChild.oid, taskBChildTip)
  assert.equal(retriedChild.mergedCommitOid, taskAChildMergeOid)

  // The containing source records B's current child tip, while A's historical
  // child merge attribution remains unchanged in the persistence ref.
  assert.equal(git(fixture.root, 'rev-parse', 'main:vendor'), taskBChildTip)
  assert.equal(
    git(fixture.sourceSubmodulePath, 'rev-parse', `refs/taskTools/merged-commits/${branch}`),
    taskAChildMergeOid,
  )
})
```

Adapt helper names to the existing fixture API; do not replace `taskAChildMergeOid` with the current child tip. This test must fail if the no-op path again conflates `oid` and `mergedCommitOid`.

## C86-15 — complete the production-shaped orchestration matrix

The three scenarios now execute real workflow envelopes through `consumeTaskWorkflowResult` and `nextQueueAction`, and they assert close/cleanup before teardown. Four acceptance gaps remain: preparation bypasses the origin-gated CLI, the gate has no rejection companion, root success never proves the task file landed, and the conflict case checks only the root task ref rather than the source-submodule ref.

### `tests/runMergePhase.test.ts`: prepare through the production CLI

Old fixture shape — current `tests/runMergePhase.test.ts:342-370` and `tests/runMergePhase.test.ts:631-674`:

```ts
const task: TaskRecord = { taskNumber, title: "fixture", files: ownedFiles, blockedBy: [] };
...
const prepared = buildWorkflowArguments(root, "true", [task]);
const worktreePath = prepared.groups[0]!.worktree;
...
const repositoryManifest = loadRepositoryManifest(root);
```

New shared helper:

```ts
type PreparedPipeline = WorkflowArguments & {
  repo: string
  repositoryManifest: RepositoryManifest
}

const addBareOrigin = (root: string): string => {
  const origin = mkdtempSync(join(tmpdir(), 'run-merge-phase-origin-'))
  git(origin, 'init', '-q', '--bare')
  git(root, 'remote', 'add', 'origin', origin)
  return origin
}

const prepareThroughCli = (root: string, taskNumber: number): PreparedPipeline => {
  const stdout = execFileSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts', 'prepareTasks.ts'), String(taskNumber)],
    { cwd: root, encoding: 'utf8' },
  )
  return JSON.parse(stdout) as PreparedPipeline
}
```

New root/submodule fixture shape:

```ts
const origin = addBareOrigin(root)
const prepared = prepareThroughCli(root, taskNumber)
const group = prepared.groups.find(
  (entry) => entry.tasks[0]?.number === taskNumber,
)!
const worktreePath = group.worktree
const repositoryManifest = prepared.repositoryManifest

assert.equal(
  repositoryManifest.occurrences.every(
    (occurrence) => occurrence.operationBranch === '',
  ),
  true,
)

return { root, origin, worktreePath, repositoryManifest, prepared }
```

Remove direct `buildWorkflowArguments` and `loadRepositoryManifest` calls from the three matrix fixtures. Clean up the bare origin in `finally`. The test run should no longer print `No such remote 'origin'` for these fixtures.

### Add the missing rejection gate

```ts
test('a do-not-approve gate never enqueues or launches tail stages', async () => {
  const taskNumber = 9105
  const fixture = makeQueueFixtureRepoV2(taskNumber, ['taskfile.txt'])
  let tailLaunches = 0

  try {
    let queue = createMergeQueue()
    const notification = await runTaskWorkflowStage(
      fixture.worktreePath,
      {
        task: taskNumber,
        stage: 'plan+implement',
        typecheckCommand: fixture.prepared.typecheckCommand,
        sourceRoot: fixture.root,
        repositoryManifest: fixture.repositoryManifest,
      },
      scriptedPlanImplementAgent(
        taskNumber,
        fixture.worktreePath,
        'taskfile.txt',
        () => writeFileSync(join(fixture.worktreePath, 'taskfile.txt'), 'task change\n'),
      ),
    )

    const consumed = consumeTaskWorkflowResult(queue, notification)
    assert.equal(consumed.kind, 'approval')
    if (consumed.kind !== 'approval') assert.fail('expected approval notification')

    const gateDecision: 'approve' | 'reject' = 'reject'
    if (gateDecision === 'approve') {
      queue = enqueueApprovedTask(queue, consumed.approval.taskNumber)
    }

    const action = nextQueueAction(queue, { any: false, tail: false })
    if (action.kind === 'launch') tailLaunches += 1
    assert.deepEqual(action, { kind: 'report', endState: 'done' })
    assert.equal(tailLaunches, 0)
    assert.equal(readCompleted(fixture.root).length, 0)
    assert.equal(readTasks(fixture.root).some((task) => task.taskNumber === taskNumber), true)
  } finally {
    cleanupQueueFixture(fixture)
  }
})
```

### Strengthen the root-success observable

Old success assertions — current `tests/runMergePhase.test.ts:425-429`:

```ts
assert.deepEqual(openTasks, []);
assert.equal(existsSync(worktreePath), false);
assert.throws(() => git(root, "show-ref", "--verify", `refs/heads/task-${taskNumber}`));
```

New:

```ts
assert.deepEqual(openTasks, [])
assert.equal(git(root, 'show', 'main:taskfile.txt'), 'task change')
assert.equal(existsSync(worktreePath), false)
assert.throws(() =>
  git(root, 'show-ref', '--verify', `refs/heads/task-${taskNumber}`))
```

### Strengthen the submodule-conflict retention observable

Old — current `tests/runMergePhase.test.ts:814-818`:

```ts
assert.equal(existsSync(worktreePath), true);
assert.doesNotThrow(() => git(root, "show-ref", "--verify", `refs/heads/task-${taskNumber}`));
```

New:

```ts
assert.equal(existsSync(worktreePath), true)
for (const repo of [root, join(root, 'vendor')]) {
  assert.doesNotThrow(() =>
    git(repo, 'show-ref', '--verify', `refs/heads/task-${taskNumber}`))
}
```

This catches premature source-submodule cleanup on the conflict path rather than relying only on the root worktree branch.

## Completion check

Run at least:

```sh
npx tsc --noEmit
node --test \
  tests/addTaskFiles.test.ts \
  tests/closeTasks.test.ts \
  tests/mergeTaskWorktrees.test.ts \
  tests/runMergePhase.test.ts \
  tests/taskArchival.test.ts \
  tests/taskFiles.test.ts \
  tests/taskWorkflowPlanImplementStage.test.ts
```

The fixes are complete only when root and nested-CWD task-state writers share the same lock, the planner cannot substitute an ambient plan path, the nested merge retry preserves both OID meanings, and all orchestration observables are asserted from production-shaped preparation output.
