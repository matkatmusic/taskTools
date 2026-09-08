# Task 153 plan — on any lap-step failure nothing further lands, worktree survives, task stays open

## Scope decision (read this before the edit list)

Owned files are exactly the five in the brief's `## Files` section:
`plans/task-86-spec.md`, `scripts/closeTasks.ts`, `skills/tackle-tasks/task.workflow.js`,
`tests/closeTasks.test.ts`, `tests/taskWorkflowMergeStage.test.ts`. (The brief's
`[split-task-child]` prose block lists only four — it omits
`tests/taskWorkflowMergeStage.test.ts` — but the `## Files` section and the task
prompt's owned-file grant both list five and agree with each other, so the five-file
list governs, per the standing "task briefs contain both description fields" lesson.)

I traced `skills/tackle-tasks/task.workflow.js`'s `runMerge` function (its only code
that can move a source branch or delete the worktree) end to end. It already:

1. Calls `cleanupPlanAndBriefFiles` first — this commits only to the task's own
   `repoRoot` (the `task-N` branch), never to a source branch. If it throws, nothing
   below it runs: no merge, no close, no worktree removal. (`task.workflow.js:681`)
2. Calls `mergeTaskDeepestFirst` and returns immediately, without calling `closeTasks`
   or `removeWorktreeAndBranch`, whenever `report.status !== 'merged'`.
   (`task.workflow.js:687-689`)
3. Calls `closeTasks` only after a confirmed `'merged'` status, and returns
   `status: 'merged-but-not-closed'` — without calling `removeWorktreeAndBranch` —
   whenever `closeTasks` throws or its `closed` array omits the task number.
   (`task.workflow.js:695-702`)
4. Calls `removeWorktreeAndBranch` last, only after a verified close.
   (`task.workflow.js:703-709`)

This is exactly the ordering the brief itself says is "already correct before this
task starts" and names as this task's job to guard, not relocate. I found no gap in
it, so **no behavioral edit to `skills/tackle-tasks/task.workflow.js` is needed** —
its only role in this plan is as the file the new tests exercise.

`scripts/closeTasks.ts` needs no edit either: "closing is gated on merging" is
enforced by `runMerge`'s call ordering above (`closeTasks` is only ever invoked after
a verified merge), not by anything inside `closeTasks.ts` itself, and its own
atomicity/idempotency is already covered by the nine tests in
`tests/closeTasks.test.ts` (concurrent-write detection, per-task Record note/hashes,
duplicate handling, retry-after-partial-close). None of task 153's new failure-path
requirements touch that file's own logic, so **`tests/closeTasks.test.ts` needs no
edit** either.

`plans/task-86-spec.md` is a read-only reference; **no edit**.

The only file this task edits is `tests/taskWorkflowMergeStage.test.ts`, adding one
test per failing lap-step named in the brief, plus one existing test reworked to
prove it:

| brief's failing step | new/existing test |
| --- | --- |
| rebase (no conflict, no fix loop) | new: a failing rebase command (shared `pre-rebase` hook) blocks the lap before any agent runs (rebase-test stage) |
| conflict resolution | new: unresolved live conflict (rebase-test stage) |
| per-layer tests / fix loop | new: layer still red after the fix-round ceiling (rebase-test stage) |
| cleanup | new: cleanup commit blocked by a hook (merge stage) |
| merge | new: a submodule layer merges while an untested parent layer blocks — submodule stays merged, parent unmoved (merge stage) |
| close | existing "merges but cannot close" test, reworked to seed a real open task and shadow `completedTasks.json` with a directory so the archive write itself fails, proving the task stays open, unarchived, while the parent's merge still landed |

Every failure-path test (new or augmented) asserts the same five things: the
parent's source branch hash is unchanged (or, for the submodule test, that the
submodule's source branch DID advance while the parent's did not; or, for the
close-failure test, that the parent's merge commit DID land, since that lap's
failure is in closing, not merging), the worktree still exists, the task's
`task-N` branch still exists (`git show-ref --verify
refs/heads/task-${taskNumber}` does not throw), the task is still in
`tasks.json`, and the task is absent from any archive (`completedTasks.json`
is `[]` for every test except the close-failure test, whose
`completedTasks.json` is deliberately shadowed by an empty directory so the
archive write itself throws — that test asserts the directory is empty
instead of parsing JSON).

Most of these tests use a single-occurrence (no-submodule) fixture, the same
shape the file's two existing tests already use: they only need to prove
`task.workflow.js`'s own guard (parent unmoved, worktree intact, task still
open) when a layer fails, not `mergeTaskDeepestFirst`'s own submodule-ordering
internals (that deepest-first, already-merged-submodules-stay-merged guarantee
has its own dedicated tests in `tests/mergeTaskWorktrees.test.ts`, added in
task 144). The merge-stage test is the one exception: it builds a real root +
submodule fixture (a second, standalone git repo added via `git submodule add`)
specifically to observe that contract from `task.workflow.js`'s own call into
`mergeTaskDeepestFirst` — proving the integration point, not re-proving the
primitive's internals. Its manifest, occurrence-ID, and checkout-path fields
are grounded in `mergeTaskDeepestFirst` (`scripts/mergeTaskWorktrees.ts:506-537`)
and `discoverOccurrenceAndDescendants` (`scripts/repositoryDiscovery.ts:74-133`),
both read in full for this plan: discovery matches an input occurrence to the
worktree-discovered one by `occurrenceId` (the gitlink's relative path, e.g.
`"vendor"`), then preserves that input occurrence's `baseBranch`, `baseOid`,
and `operationBranch` verbatim whenever `baseBranch` is already non-empty
(`repositoryDiscovery.ts:92-94,119`) — the same mechanism the file's two
existing single-occurrence tests already depend on for the root occurrence.
`sourceCheckoutPathByOccurrenceId` is captured from the manifest before
discovery mutates `checkoutPath` in place (`mergeTaskWorktrees.ts:511-515`), so
the submodule occurrence's `checkoutPath` must be the submodule's checkout
inside `root` (`join(root, 'vendor')`) — never the worktree's copy, and never
the standalone repo passed to `git submodule add`, which only seeds history and
is not read again after that point.

Every new rebase-test-stage and merge-stage test relies only on
`task.workflow.js` code read in full, `mergeTaskDeepestFirst`,
`discoverOccurrenceAndDescendants`, and `rebaseGroupOntoSource` /
`rebaseParentOntoSourceAndTest` as cited above and below, plus two facts
stated in `plans/task-86-spec.md` (`scripts/testPolicy.ts` itself was not
read; only the observable, spec-guaranteed contract is asserted):

- "Each repository's test command is discovered by calling `discoverTestPolicy`
  ... A repo returning `no-test-configuration` is UNTESTED, and untested is not
  green." — grounds every "no `package.json` test script at all → blocked" fixture
  (mirrors the existing test file's own comment at line 38: "mergeTaskDeepestFirst
  needs a package.json test script or it reports the parent layer untested and
  refuses to merge"). The merge-stage submodule test's root layer is this exact
  fixture (no `package.json` at all), which is why its parent blocks after the
  submodule merges.
- "5. Only once every layer is green, merge... Nothing merges untested." — grounds
  asserting the merge status is not `'merged'` and the source branch is unmoved,
  without asserting the exact status string `mergeTaskDeepestFirst` uses (that
  string lives in a file whose merge-status-string internals were not the target
  of this reading, so the test only asserts the observable, spec-guaranteed
  contract: not merged, parent hash unchanged, worktree intact, task still open).

For the rebase-test-stage tests (rebase-command failure, conflict, fix-loop
ceiling) every assertion is grounded directly in code read in full: the
literal status strings `'cleanup-failed'` (`scripts/mergeTaskWorktrees.ts`'s
`rebaseGroupOntoSource`: `git rebase` itself throws, then `rebaseInProgress`
at line 164 finds no `rebase-merge`/`rebase-apply` directory since the hook
blocked the rebase before it started, so the function returns
`{ status: "cleanup-failed" }`; `rebaseParentOntoSourceAndTest` passes that
status straight through at lines 366-368; `task.workflow.js:649-650` then sets
`lastFailure` to the raw status because it isn't `'untested'`),
`'unresolved merge conflict'` (`task.workflow.js:519`, returned at line 635 via
`advanceLiveConflict`'s `outcome.lastFailure`), and `'layer still red after
MAX_REBASE_FIX_ROUNDS'` (`task.workflow.js:617` and `641`); the fact that a
real git rebase conflict (both branches editing the same line of the same
file) hits live conflict markers — documented in the file's own
`mergeConflictBrief` text ("stopped on live conflict markers, not aborted").
The new dedicated rebase-only test gives the source and task branches
divergent commits, then installs a shared, executable `.git/hooks/pre-rebase`
that exits nonzero, so `git rebase` fails before it ever starts and the
conflict/fix-loop code paths are never reached — the one rebase-test-stage
failure that happens before any agent call is even possible, so it fails
with the default `throwingAgent` still installed, proving no agent call
happened, since any call would throw and fail the test loudly. (An earlier
draft of this test used an untested root layer with identical, non-divergent
branches instead; `git rebase` there is a same-commit no-op that never
invokes the rebase machinery at all, so that draft only proved the
already-covered untested-layer contract, not a real rebase-command failure —
which is why the merge-stage submodule test, not this one, is this plan's one
legitimate untested-layer case.)

## Edits — `tests/taskWorkflowMergeStage.test.ts`

### Edit 1 — imports (line 4)

Current text:
```
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
```

Becomes:
```
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
```

(Adds `chmodSync`, needed by the new cleanup-failure test and the new
rebase-command-failure test to make their fixtures' `pre-commit`/`pre-rebase`
hooks executable, and `readdirSync`, needed by the reworked close-failure test
to prove its directory-shadowed `completedTasks.json` stays empty.)

### Edit 2 — `runMergeStage` gains an overridable agent (lines 21-34)

Current text:
```
const runMergeStage = async (worktreePath: string, args: Record<string, unknown>) => {
  const fn = new AsyncFunction('args', 'log', 'agent', `'use strict'\n${WORKFLOW_SOURCE}`)
  const previousCwd = process.cwd()
  process.chdir(worktreePath)
  try {
    return await fn(
      JSON.stringify(args),
      () => {},
      async () => { throw new Error('merge stage must not call an agent') },
    )
  } finally {
    process.chdir(previousCwd)
  }
}
```

Becomes:
```
const throwingAgent = async () => { throw new Error('merge stage must not call an agent') }

const runMergeStage = async (worktreePath: string, args: Record<string, unknown>, agentImpl: (...values: unknown[]) => Promise<unknown> = throwingAgent) => {
  const fn = new AsyncFunction('args', 'log', 'agent', `'use strict'\n${WORKFLOW_SOURCE}`)
  const previousCwd = process.cwd()
  process.chdir(worktreePath)
  try {
    return await fn(
      JSON.stringify(args),
      () => {},
      agentImpl,
    )
  } finally {
    process.chdir(previousCwd)
  }
}
```

(The two existing call sites pass only two arguments, so `agentImpl` defaults to
`throwingAgent` for them — unchanged behavior. The new rebase-test-stage tests pass
a third argument, a stub that answers the conflict/fix agent and throws on any other
label, so an unexpected agent call fails the test loudly instead of hanging.)

### Edit 3 — parameterize the test-script helper (lines 38-43)

Current text:
```
// mergeTaskDeepestFirst needs a package.json test script or it reports the parent layer untested and refuses to merge.
const addPassingTestScript = (repoPath: string) => {
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }))
  git(repoPath, 'add', 'package.json')
  git(repoPath, 'commit', '-q', '-m', 'add test script')
}
```

Becomes:
```
// mergeTaskDeepestFirst needs a package.json test script or it reports the parent layer untested and refuses to merge.
const addTestScript = (repoPath: string, command: string) => {
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { test: command } }))
  git(repoPath, 'add', 'package.json')
  git(repoPath, 'commit', '-q', '-m', 'add test script')
}
```

### Edit 4 — `makeRootWithWorktree` takes an optional test-script override (lines 45 and 54)

Current text (line 45):
```
const makeRootWithWorktree = (taskNumber: number) => {
```

Becomes:
```
const makeRootWithWorktree = (taskNumber: number, { testScript = 'true' }: { testScript?: string } = {}) => {
```

Current text (line 54):
```
  addPassingTestScript(root)
```

Becomes:
```
  addTestScript(root, testScript)
```

(Existing two call sites pass only `taskNumber`, so `testScript` defaults to
`'true'` — identical behavior to today's hardcoded passing script. The new
fix-loop-ceiling test passes `{ testScript: 'false' }` for a failing-but-present
script. No test needs "no script at all" — the merge-stage submodule test's
untested root layer builds its own fixture instead, see Edit 5 — so this helper
carries no `null` case.)

### Edit 5 — append five new tests after the current last line (end of file, after line 158's `})`)

Append, verbatim:
```

test('rebase stage: a failing rebase command blocks the lap before any agent runs', async () => {
  const taskNumber = 9007
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(root, 'mainfile.txt'), 'main change\n')
    git(root, 'add', 'mainfile.txt')
    git(root, 'commit', '-q', '-m', 'main change')

    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    writeFileSync(join(root, '.git', 'hooks', 'pre-rebase'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(root, '.git', 'hooks', 'pre-rebase'), 0o755)

    const headBefore = git(root, 'rev-parse', 'main')
    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'rebase-test', repositoryManifest })

    const outcome = result.results[0] as { status: string, lastFailure: string }
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.lastFailure, 'cleanup-failed')
    assert.equal(git(root, 'rev-parse', 'main'), headBefore)
    assert.equal(existsSync(worktreePath), true)
    assert.doesNotThrow(() => git(root, 'show-ref', '--verify', `refs/heads/task-${taskNumber}`))
    const stillOpen = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8'))
    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(stillOpen.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.deepEqual(archived, [])
  } finally {
    removeFixture(root, worktreePath)
  }
})

test('rebase stage: an unresolved live conflict blocks the lap and leaves the source branch unmoved', async () => {
  const taskNumber = 9003
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'README.md'), 'task change\n')
    git(worktreePath, 'add', 'README.md')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    writeFileSync(join(root, 'README.md'), 'main change\n')
    git(root, 'add', 'README.md')
    git(root, 'commit', '-q', '-m', 'main change')

    const conflictAgent = async (...values: unknown[]) => {
      const options = values[1] as { label: string }
      if (options.label.startsWith('rebase-conflict:')) return { resolved: false, summary: 'cannot resolve' }
      throw new Error(`unexpected agent call: ${options.label}`)
    }

    const headBefore = git(root, 'rev-parse', 'main')
    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'rebase-test', repositoryManifest }, conflictAgent)

    const outcome = result.results[0] as { status: string, lastFailure: string }
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.lastFailure, 'unresolved merge conflict')
    assert.equal(git(root, 'rev-parse', 'main'), headBefore)
    assert.equal(existsSync(worktreePath), true)
    assert.doesNotThrow(() => git(root, 'show-ref', '--verify', `refs/heads/task-${taskNumber}`))
    const stillOpen = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8'))
    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(stillOpen.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.deepEqual(archived, [])
  } finally {
    removeFixture(root, worktreePath)
  }
})

test('rebase stage: a layer still red after the fix-round ceiling blocks the lap and leaves the source branch unmoved', async () => {
  const taskNumber = 9004
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber, { testScript: 'false' })
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(root, 'mainfile.txt'), 'main change\n')
    git(root, 'add', 'mainfile.txt')
    git(root, 'commit', '-q', '-m', 'main change')

    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    const fixAgent = async (...values: unknown[]) => {
      const options = values[1] as { label: string }
      if (options.label.startsWith('rebase-fix:')) return { fixed: false, summary: 'could not fix' }
      throw new Error(`unexpected agent call: ${options.label}`)
    }

    const headBefore = git(root, 'rev-parse', 'main')
    const result = await runMergeStage(
      worktreePath,
      { task: taskNumber, stage: 'rebase-test', repositoryManifest, maxRebaseFixRounds: 1 },
      fixAgent,
    )

    const outcome = result.results[0] as { status: string, lastFailure: string }
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.lastFailure, 'layer still red after MAX_REBASE_FIX_ROUNDS')
    assert.equal(git(root, 'rev-parse', 'main'), headBefore)
    assert.equal(existsSync(worktreePath), true)
    assert.doesNotThrow(() => git(root, 'show-ref', '--verify', `refs/heads/task-${taskNumber}`))
    const stillOpen = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8'))
    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(stillOpen.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.deepEqual(archived, [])
  } finally {
    removeFixture(root, worktreePath)
  }
})

test('merge stage: a cleanup commit blocked by a hook leaves the source branch unmoved and the worktree intact', async () => {
  const taskNumber = 9005
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`), 'plan\n')
    writeFileSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`), 'brief\n')
    git(worktreePath, 'add', `plans/task-${taskNumber}-plan.md`, `plans/brief-${taskNumber}.md`)
    git(worktreePath, 'commit', '-q', '-m', 'plan and brief')

    writeFileSync(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(root, '.git', 'hooks', 'pre-commit'), 0o755)

    const headBefore = git(root, 'rev-parse', 'main')
    const worktreeHeadBefore = git(worktreePath, 'rev-parse', 'HEAD')

    await assert.rejects(() => runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest }))

    assert.equal(git(root, 'rev-parse', 'main'), headBefore)
    assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), worktreeHeadBefore)
    assert.equal(existsSync(worktreePath), true)
    assert.doesNotThrow(() => git(root, 'show-ref', '--verify', `refs/heads/task-${taskNumber}`))
    const stillOpen = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8'))
    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(stillOpen.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.deepEqual(archived, [])
  } finally {
    removeFixture(root, worktreePath)
  }
})

test('merge stage: after a submodule layer merges, an untested parent layer blocks the lap while the submodule stays merged', async () => {
  const taskNumber = 9006
  process.env.GIT_ALLOW_PROTOCOL = 'file'

  const submoduleSource = mkdtempSync(join(tmpdir(), 'task-workflow-merge-submodule-'))
  git(submoduleSource, 'init', '-q', '-b', 'main')
  git(submoduleSource, 'config', 'user.email', 'test@example.com')
  git(submoduleSource, 'config', 'user.name', 'Test')
  git(submoduleSource, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(submoduleSource, 'vendor.txt'), 'vendor\n')
  git(submoduleSource, 'add', 'vendor.txt')
  git(submoduleSource, 'commit', '-q', '-m', 'init')
  addTestScript(submoduleSource, 'true')

  const root = mkdtempSync(join(tmpdir(), 'task-workflow-merge-root-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'README.md'), 'root\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-q', '-m', 'init')
  git(root, 'submodule', 'add', '-q', submoduleSource, 'vendor')
  git(root, 'commit', '-q', '-m', 'add submodule')
  // root itself gets no package.json test script, so its own layer is untested and blocks after the submodule merges.

  const sourceBranch = 'main'
  const submoduleCheckoutPath = join(root, 'vendor')
  const baseOid = git(root, 'rev-parse', sourceBranch)
  const submoduleBaseOid = git(submoduleCheckoutPath, 'rev-parse', sourceBranch)
  const operationBranch = `task-${taskNumber}`
  const worktreePath = join(tmpdir(), `task-workflow-merge-wt-${randomUUID()}`)
  git(root, 'worktree', 'add', '-q', '-b', operationBranch, worktreePath, sourceBranch)
  git(worktreePath, 'submodule', 'update', '--init', '--recursive', '-q')
  git(join(worktreePath, 'vendor'), 'checkout', '-q', '-b', operationBranch)
  mkdirSync(join(worktreePath, 'plans'), { recursive: true })
  symlinkSync(join(REPO_ROOT, 'scripts'), join(worktreePath, 'scripts'))

  const repositoryManifest: RepositoryManifest = {
    version: REPOSITORY_MANIFEST_VERSION,
    occurrences: [
      {
        occurrenceId: '',
        checkoutPath: root,
        parentOccurrenceId: null,
        pathInParent: null,
        gitlinkOid: null,
        depth: 0,
        originUrl: '',
        baseBranch: sourceBranch,
        baseOid,
        operationBranch,
        childOccurrenceIds: ['vendor'],
        testState: 'untested',
      },
      {
        occurrenceId: 'vendor',
        checkoutPath: submoduleCheckoutPath,
        parentOccurrenceId: '',
        pathInParent: 'vendor',
        gitlinkOid: null,
        depth: 1,
        originUrl: '',
        baseBranch: sourceBranch,
        baseOid: submoduleBaseOid,
        operationBranch,
        childOccurrenceIds: [],
        testState: 'untested',
      },
    ],
  }

  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'vendor', 'vendor-new.txt'), 'vendor change\n')
    git(join(worktreePath, 'vendor'), 'add', 'vendor-new.txt')
    git(join(worktreePath, 'vendor'), 'commit', '-q', '-m', 'vendor change')
    git(worktreePath, 'add', 'vendor')
    git(worktreePath, 'commit', '-q', '-m', 'point at vendor task commit')

    const rootHeadBefore = git(root, 'rev-parse', sourceBranch)
    const submoduleHeadBefore = git(submoduleCheckoutPath, 'rev-parse', sourceBranch)
    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest })

    const outcome = result.results[0] as { status: string }
    assert.notEqual(outcome.status, 'merged')
    assert.equal(git(root, 'rev-parse', sourceBranch), rootHeadBefore)
    assert.notEqual(git(submoduleCheckoutPath, 'rev-parse', sourceBranch), submoduleHeadBefore)
    assert.equal(existsSync(worktreePath), true)
    assert.doesNotThrow(() => git(root, 'show-ref', '--verify', `refs/heads/task-${taskNumber}`))
    const stillOpen = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8'))
    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(stillOpen.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.deepEqual(archived, [])
  } finally {
    removeFixture(root, worktreePath)
    rmSync(submoduleSource, { recursive: true, force: true })
  }
})
```

Notes on this block:
- `conflictAgent`/`fixAgent` are typed `(...values: unknown[]) => Promise<unknown>`
  (matching `agentImpl`'s parameter type exactly, avoiding any function-parameter
  variance issue) and narrow `values[1]` to `{ label: string }` inside the body,
  the same shape `task.workflow.js` passes as its second `agent(...)` argument
  (`{ label, phase, schema }`) at every call site I read (e.g.
  `agent(mergeConflictBrief(...), { label: \`rebase-conflict:${N}\`, ... })`).
- Task numbers 9003-9007 are new and don't collide with the existing tests' 9001/9002.
- No `mkdirSync` is needed for `.git/hooks` — `git init` already creates it.
- The pre-commit and pre-rebase hooks are written to `root/.git/hooks/`, not the
  worktree — worktrees share the common `.git/hooks` directory with their main
  checkout, so a commit or rebase run with `-C <worktreePath>` still runs them.
- The rebase-command-failure test's `pre-rebase` hook exits nonzero before `git
  rebase` creates a `rebase-merge`/`rebase-apply` state directory, so
  `rebaseGroupOntoSource` finds no rebase in progress and reports
  `'cleanup-failed'` without ever reaching the conflict or fix-agent paths.
- The submodule test builds its own fixture instead of calling `makeRootWithWorktree`,
  because that helper only ever creates a single occurrence. It follows the same
  git-command idioms `makeRootWithWorktree` and `addTestScript` already use.
- `git submodule add` needs `GIT_ALLOW_PROTOCOL=file` in this environment — git
  >=2.38 blocks the plain `file://`-equivalent local-path transport by default.
- The submodule occurrence's `checkoutPath` is `join(root, 'vendor')` — the
  submodule's checkout inside `root`, i.e. the one `mergeTaskDeepestFirst` actually
  merges into — never `submoduleSource` (only used to seed history for `git
  submodule add` and never read again) and never the worktree's copy (that path is
  computed fresh by `discoverRepositoryTree`, not read from this input manifest).

### Edit 6 — rework the close-failure test to seed a real open task and prove it survives (lines 136-158)

Current text (the whole test):
```
// No task files, so the close fails and the worktree survives: the only retryable lap.
test('a lap that merges but cannot close keeps the worktree, and its retried cleanup makes no second commit', async () => {
  const taskNumber = 9002
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  try {
    writeFileSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`), 'plan\n')
    writeFileSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`), 'brief\n')

    const first = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest })
    assert.equal((first.results[0] as { status: string }).status, 'merged-but-not-closed')
    assert.equal(existsSync(worktreePath), true)
    assert.equal(existsSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`)), false)
    assert.equal(existsSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`)), false)

    const headBeforeRetry = git(root, 'rev-parse', 'main')
    const worktreeHeadBeforeRetry = git(worktreePath, 'rev-parse', 'HEAD')
    const second = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest })
    assert.equal((second.results[0] as { status: string }).status, 'merged-but-not-closed')
    assert.equal(git(root, 'rev-parse', 'main'), headBeforeRetry)
    assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), worktreeHeadBeforeRetry)
  } finally {
    removeFixture(root, worktreePath)
  }
})
```

Becomes:
```
// Seeded with a real open task; completedTasks.json is a directory so the archive write throws.
test('a lap that merges but cannot close keeps the worktree, and its retried cleanup makes no second commit', async () => {
  const taskNumber = 9002
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    writeFileSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`), 'plan\n')
    writeFileSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`), 'brief\n')

    rmSync(join(root, '.taskTools', 'completedTasks.json'))
    mkdirSync(join(root, '.taskTools', 'completedTasks.json'))

    const headBeforeMerge = git(root, 'rev-parse', 'main')
    const first = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest })
    const firstOutcome = first.results[0] as { status: string, mergedCommitHash: string }
    assert.equal(firstOutcome.status, 'merged-but-not-closed')
    assert.notEqual(firstOutcome.mergedCommitHash, headBeforeMerge)
    assert.equal(git(root, 'rev-parse', 'main'), firstOutcome.mergedCommitHash)
    assert.equal(existsSync(worktreePath), true)
    assert.equal(existsSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`)), false)
    assert.equal(existsSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`)), false)

    const headBeforeRetry = git(root, 'rev-parse', 'main')
    const worktreeHeadBeforeRetry = git(worktreePath, 'rev-parse', 'HEAD')
    const second = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest })
    assert.equal((second.results[0] as { status: string }).status, 'merged-but-not-closed')
    assert.equal(git(root, 'rev-parse', 'main'), headBeforeRetry)
    assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), worktreeHeadBeforeRetry)
    assert.doesNotThrow(() => git(root, 'show-ref', '--verify', `refs/heads/task-${taskNumber}`))
    const stillOpen = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8'))
    assert.deepEqual(stillOpen.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.deepEqual(readdirSync(join(root, '.taskTools', 'completedTasks.json')), [])
  } finally {
    removeFixture(root, worktreePath)
  }
})
```

(This is the task's own CLOSE failure case: the parent legitimately DID merge, so
this test does not — and must not — assert an unchanged parent hash; instead it
asserts the merge commit landed, via `mergedCommitHash` (`task.workflow.js:692`,
`rootLayer.oid`) matching main's new tip. The old fixture never called
`seedTaskFiles`, so it had no `tasks.json` at all — `closeTasks` threw on the
first `readFileSync(tasksPath, ...)` (`scripts/closeTasks.ts:85`) before it could
prove anything about a real open task surviving. This rework seeds a real open
task, then instead shadows `completedTasks.json` with a directory: `closeTasks`
reads `tasksPath` fine, resolves the close, and only then throws — reading a
directory as a file (`scripts/closeTasks.ts:59`, `hashGuardedRewrite`'s first
`readFileSync(targetPath)` on `completedTasksPath`) — before it ever writes
`tasksPath` (line 132), so the seeded task record is provably untouched. It also
adds a real `taskfile.txt` commit on the task branch, since without any
divergence from `main` the root layer is a same-commit no-op
(`scripts/mergeTaskWorktrees.ts:534-537`, `unmergedCommitCount === 0`) and never
produces a real merge commit to prove landed.)

## Verification

Run:
```
npm test
```
Expected: the full suite passes, including these seven test names printed as
passing under `tests/taskWorkflowMergeStage.test.ts` (the two pre-existing —
one reworked by Edit 6 — plus the five added by Edit 5):
- `merge stage deletes plan and brief, keeps notes, closes the task against the merged hash, and removes the worktree last`
- `a lap that merges but cannot close keeps the worktree, and its retried cleanup makes no second commit`
- `rebase stage: a failing rebase command blocks the lap before any agent runs`
- `rebase stage: an unresolved live conflict blocks the lap and leaves the source branch unmoved`
- `rebase stage: a layer still red after the fix-round ceiling blocks the lap and leaves the source branch unmoved`
- `merge stage: a cleanup commit blocked by a hook leaves the source branch unmoved and the worktree intact`
- `merge stage: after a submodule layer merges, an untested parent layer blocks the lap while the submodule stays merged`

Also run, to confirm no regression from the shared-file edits:
```
node --test tests/closeTasks.test.ts
```
Expected: all 9 existing tests still pass (this file is unedited, so this is a
no-op confirmation, not a new assertion).
