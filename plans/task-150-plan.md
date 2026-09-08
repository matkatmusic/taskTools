# Task 150 plan — programmatic cleanup of a task's plan and brief before merge

## Goal (from plans/brief-150.md)

On success for one task, the `merge` stage of `skills/tackle-tasks/task.workflow.js`
deletes `plans/task-<N>-plan.md` and `plans/brief-<N>.md`, as plain code (no agent),
as part of the task's own worktree commit, without touching
`plans/task-<N>-implementation-notes.md`, and idempotently (a retried lap with both
files already gone must succeed with no error and no empty commit).

## Files accounted for

- `plans/task-86-spec.md` — read-only design reference. No edit. It documents the
  overall task-86 design (source of the "one worktree per task", "serial tail" and
  "delete plan + brief" language quoted in the brief); task 150 implements a piece of
  it but does not change the spec document itself.
- `skills/tackle-tasks/task.workflow.js` — two edits (below).
- `tests/taskWorkflowMergeStage.test.ts` — does not exist yet. Created by this task
  with the full content given below.

## Background the implementer needs (established while planning, not to be re-derived)

`skills/tackle-tasks/task.workflow.js` is not a plain importable ES module: it has a
top-level `return { task: N, stage: STAGE, results: await runner() }` as its last
line (line 676 today), which is a `SyntaxError: Illegal return statement` under both
plain Node ESM `import()` and a bare `new Function(...)` wrapper — this was verified
directly (`node --check` on a reduced file with the same shape fails with exactly that
error). The file also has exactly one `export` in it today (`export const meta = ...`
at line 9); nothing else in the file is exported. This means the file is executed by
a bespoke harness outside this repository (the "workflow" launcher), not by
`node --test`/`import()`, and no test in this repo can `import` it directly.

To let `tests/taskWorkflowMergeStage.test.ts` still drive the **real** code in
`task.workflow.js` against a **real** git worktree (as the brief requires, and not by
inspecting generated prompt text), the test loads the file's source text, replaces
the literal substring `'export const meta'` with `'const meta'` (the only export in
the file, so no export syntax remains), and runs the result as the body of a
`new Function(...).constructor` async-function ("AsyncFunction") value with
`args`, `log`, `agent` as its three parameters — exactly the three free identifiers
the file's top-level code references. This was verified end-to-end in a sandbox with
a reduced file of the same shape (module-level `const`/`export const`/async arrow
functions with `await import(...)`, dispatch through a `STAGE_RUNNERS` map, ending in
the same top-level `return`): the transform parses and runs correctly and produces the
same result shape production code returns. `await import('node:...')` calls inside the
body work unchanged inside an AsyncFunction, so this does not require transpiling or
executing any of the dynamically-imported `./scripts/*.ts` files — and because the new
`runMerge` (below) does not import any of them, none of those modules are touched
when the test runs the `merge` stage.

The new `runMerge` uses `process.cwd()` for `repoRoot`, exactly like every other stage
in the file (`loadPreparedTask` does `const repoRoot = process.cwd()` at line 333) —
this is required already, is not a new pattern, and lets the test select which
worktree to operate on by `process.chdir()`-ing into a temp fixture before invoking
the wrapped workflow and restoring the previous cwd in a `finally` block. `node --test`
runs each test file in its own process, and this test file's two `test()` blocks are
the only code in the process, run sequentially (Node's test runner runs a file's own
top-level tests in registration order by default), so the temporary `process.chdir()`
cannot race with anything else in the file.

Git behaviour relied on below, verified directly in a sandbox git repo:
- `git rm -f --ignore-unmatch -- <path> <path2>` exits 0 whether each path is absent,
  untracked-but-present, or tracked-and-present; for a tracked-and-present path it
  both deletes the file from disk and stages the deletion; for an absent or
  untracked path it leaves the working tree untouched (does not error, does not
  delete an untracked file).
- Plain `git commit -m "..."` (no `--allow-empty`) exits non-zero ("nothing to
  commit, working tree clean") when nothing is staged.
- `git diff --cached --quiet` exits 0 when nothing is staged and exits 1 (throws
  under `execFileSync`) when something is staged — the cheap way to decide whether
  to commit.

Given `git rm` only removes files that are tracked, and today's planner/worker code
never `git add`s the plan or brief files (only `t.files` + `notesFile`, see the
existing `workerBrief` git-add line), the common case is: the plan and brief are
untracked scratch files on disk, `git rm --ignore-unmatch` is a no-op for them, and
they must also be deleted with a plain filesystem removal. A file can still end up
tracked (e.g. a rebase-fix or conflict-resolution commit elsewhere in this file uses
`git add -A`), so the cleanup step must handle both a tracked and an untracked file,
which is exactly what combining `git rm -f --ignore-unmatch` with a `fs.existsSync` /
`fs.unlinkSync` sweep does.

## Edit 1 — `skills/tackle-tasks/task.workflow.js`, lines 656–659

Current text:
```js
const runMerge = () => {
  log(`task ${N}: merge stage (stub)`)
  return { stage: 'merge', task: N }
}
```

Becomes:
```js
const cleanupPlanAndBriefFiles = (execFileSync, existsSync, unlinkSync, join, repoRoot) => {
  const relativePaths = [`plans/task-${N}-plan.md`, `plans/brief-${N}.md`]
  execFileSync('git', ['-C', repoRoot, 'rm', '-f', '--ignore-unmatch', '--', ...relativePaths], { stdio: 'ignore' })
  for (const relativePath of relativePaths) {
    const absolutePath = join(repoRoot, relativePath)
    if (existsSync(absolutePath)) unlinkSync(absolutePath)
  }
  try {
    execFileSync('git', ['-C', repoRoot, 'diff', '--cached', '--quiet'], { stdio: 'ignore' })
  } catch {
    execFileSync('git', ['-C', repoRoot, 'commit', '-m', `task ${N}: remove plan and brief`], { stdio: 'ignore' })
  }
}

const runMerge = async () => {
  log(`task ${N}: merge stage`)
  const repoRoot = process.cwd()
  const { execFileSync } = await import('node:child_process')
  const { existsSync, unlinkSync } = await import('node:fs')
  const { join } = await import('node:path')
  cleanupPlanAndBriefFiles(execFileSync, existsSync, unlinkSync, join, repoRoot)
  return { stage: 'merge', task: N }
}
```

This follows the same parameter-injection style as the file's other module-scope
helpers (`readHeadOid`, `changedPathsSinceOid`, `commitOccurrenceChanges`,
`abortRebaseChecked`, `continueRebaseChecked` all take `execFileSync` as a parameter
rather than importing it themselves), and the same "load builtins with `await
import(...)` inside the async stage function" style already used in `runImplement`
and `runRebaseTest`.

## Edit 2 — `skills/tackle-tasks/task.workflow.js`, line 665

Current text:
```js
  merge: () => [runMerge()],
```

Becomes:
```js
  merge: async () => [await runMerge()],
```

(Matches the existing `'rebase-test': async () => [await runRebaseTest()],` line
directly above it — `runMerge` is now async because of its `await import(...)` calls.)

No other lines in `skills/tackle-tasks/task.workflow.js` change.

## Edit 3 — create `tests/taskWorkflowMergeStage.test.ts`

The file does not exist. Create it with exactly this content:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const REPO_ROOT = process.cwd()
const WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT, 'skills/tackle-tasks/task.workflow.js'), 'utf8')
  .replace('export const meta', 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...params: string[]
) => (argsJson: string, log: (...values: unknown[]) => void, agent: (...values: unknown[]) => Promise<unknown>) => Promise<{
  task: number
  stage: string
  results: Array<{ stage: string; task: number }>
}>

const runMergeStage = async (worktreePath: string, taskNumber: number) => {
  const fn = new AsyncFunction('args', 'log', 'agent', `'use strict'\n${WORKFLOW_SOURCE}`)
  const previousCwd = process.cwd()
  process.chdir(worktreePath)
  try {
    return await fn(
      JSON.stringify({ task: taskNumber, stage: 'merge' }),
      () => {},
      async () => { throw new Error('merge stage must not call an agent') },
    )
  } finally {
    process.chdir(previousCwd)
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

const makeRootWithWorktree = (taskNumber: number) => {
  const root = mkdtempSync(join(tmpdir(), 'task-workflow-merge-root-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'README.md'), 'root\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-q', '-m', 'init')
  const worktreePath = join(tmpdir(), `task-workflow-merge-wt-${randomUUID()}`)
  git(root, 'worktree', 'add', '-q', '-b', `task-${taskNumber}`, worktreePath, 'main')
  mkdirSync(join(worktreePath, 'plans'), { recursive: true })
  return { root, worktreePath }
}

const removeFixture = (root: string, worktreePath: string) => {
  rmSync(worktreePath, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
}

test('merge stage deletes plan and brief, keeps notes, and the deletion survives the merge into main', async () => {
  const taskNumber = 9001
  const { root, worktreePath } = makeRootWithWorktree(taskNumber)
  try {
    writeFileSync(join(worktreePath, 'plans', `task-${taskNumber}-implementation-notes.md`), 'notes\n')
    git(worktreePath, 'add', `plans/task-${taskNumber}-implementation-notes.md`)
    git(worktreePath, 'commit', '-q', '-m', 'implementation notes')

    writeFileSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`), 'plan\n')
    writeFileSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`), 'brief\n')
    git(worktreePath, 'add', `plans/task-${taskNumber}-plan.md`, `plans/brief-${taskNumber}.md`)
    git(worktreePath, 'commit', '-q', '-m', 'plan and brief')

    const result = await runMergeStage(worktreePath, taskNumber)
    assert.deepEqual(result, { task: taskNumber, stage: 'merge', results: [{ stage: 'merge', task: taskNumber }] })

    assert.equal(existsSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`)), false)
    assert.equal(existsSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`)), false)
    assert.equal(existsSync(join(worktreePath, 'plans', `task-${taskNumber}-implementation-notes.md`)), true)
    assert.equal(git(worktreePath, 'status', '--porcelain'), '')

    git(root, 'merge', '-q', '--ff-only', `task-${taskNumber}`)
    assert.equal(git(root, 'show', `main:plans/task-${taskNumber}-implementation-notes.md`), 'notes')
    assert.throws(() => git(root, 'show', `main:plans/task-${taskNumber}-plan.md`))
    assert.throws(() => git(root, 'show', `main:plans/brief-${taskNumber}.md`))
  } finally {
    removeFixture(root, worktreePath)
  }
})

test('merge stage cleanup is idempotent: a retried lap with plan and brief already gone makes no commit', async () => {
  const taskNumber = 9002
  const { root, worktreePath } = makeRootWithWorktree(taskNumber)
  try {
    writeFileSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`), 'plan\n')
    writeFileSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`), 'brief\n')

    await runMergeStage(worktreePath, taskNumber)
    assert.equal(existsSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`)), false)
    assert.equal(existsSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`)), false)
    assert.equal(git(worktreePath, 'status', '--porcelain'), '')

    const headBeforeRetry = git(worktreePath, 'rev-parse', 'HEAD')
    const result = await runMergeStage(worktreePath, taskNumber)
    assert.deepEqual(result, { task: taskNumber, stage: 'merge', results: [{ stage: 'merge', task: taskNumber }] })
    assert.equal(git(worktreePath, 'rev-parse', 'HEAD'), headBeforeRetry)
    assert.equal(git(worktreePath, 'status', '--porcelain'), '')
  } finally {
    removeFixture(root, worktreePath)
  }
})
```

Notes on this test file:
- The first test covers the case where the plan and brief ended up **tracked** (the
  realistic path for the "own worktree commit... lands with the merge" requirement in
  the goal — a tracked file is the only case where a commit is actually needed) and
  proves the merge behaviour end-to-end by doing the (still test-local, since task 151
  is what adds this to production) `git merge --ff-only` into `main` and reading the
  resulting tree with `git show main:<path>`.
- The second test covers the case where the plan and brief are **untracked** (today's
  actual convention — see Background above) for the first cleanup call, then calls
  cleanup a second time to prove the documented retry scenario: "on a retried lap the
  plan and brief are already gone... never an empty commit."
- Neither test calls the real `agent` — the stub passed in throws if invoked, which
  is itself an assertion that the merge stage's cleanup never calls an agent (goal:
  "The deletion is plain code in the workflow, not an agent asked to tidy up").

## Verification

Run, from the repo root:

```
node --test tests/taskWorkflowMergeStage.test.ts
```
Expected: both tests pass (`# pass 2`, `# fail 0` in the summary), no output from a
thrown "merge stage must not call an agent" error.

```
npm test
```
Expected: the full suite passes, including the two new tests, with no other test
file's results changed by this edit (this task only adds `cleanupPlanAndBriefFiles`
and touches `runMerge` / the `merge` entry of `STAGE_RUNNERS` in
`skills/tackle-tasks/task.workflow.js`, and does not touch anything imported by the
`plan`, `implement`, or `rebase-test` stages).
