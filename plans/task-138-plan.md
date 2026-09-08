# Task 138 plan: programmatic owned-files fence check after the implement commit

## Owned files

- `skills/tackle-tasks/task.workflow.js` — one edit (below).

## Summary

`runImplement` in `skills/tackle-tasks/task.workflow.js` currently returns the
worker's result with no check that the commit it made stayed inside the
task's owned files. Add a plain-code fence check: capture the `HEAD` commit
before the worker runs, and — unconditionally, after all worker attempts,
whatever status the worker reported — run
`git -C <repoRoot> diff --name-only -z <base>..HEAD`, split it on NUL into
paths, drop the implementation-notes file (exempt by design), and compare every
remaining path against the task's live `files` list. Anything not in that
list is a fence violation, collected into a new `fenceViolations` array and
returned as part of the stage result — never used to revert, reset, amend,
or re-run anything.

`preparedTask.files` is already the live, possibly-widened list (updated in
place by `widenFilesAndReplan` during the plan stage — same object reference
`runImplement` reads from), so no separate "snapshot vs. live" handling is
needed: reading `preparedTask.files` at check time already satisfies "use the
list as it stands at check time."

## Exact edit

File: `skills/tackle-tasks/task.workflow.js`, lines 339-354.

Current text (read from the file):

```
const runImplement = async () => {
  log(`task ${N}: implement stage`)
  if (!preparedTask) preparedTask = await loadPreparedTask()
  let result = await runWorker(preparedTask, '') ?? {
    task: N,
    status: 'blocked',
    summary: 'worker agent returned no result after 3 attempts (killed, errored, or blocked)',
    remaining: [],
    notesFile: preparedTask.notesFile,
  }
  if (result.status === 'partial') {
    const note = `A previous worker finished part of this plan; still remaining: ${result.remaining.join('; ')}. Check the file state before redoing anything.`
    result = (await runWorker(preparedTask, note)) ?? result
  }
  return { stage: 'implement', ...result, files: preparedTask.files }
}
```

Becomes:

```
const runImplement = async () => {
  log(`task ${N}: implement stage`)
  if (!preparedTask) preparedTask = await loadPreparedTask()
  const { execFileSync } = await import('node:child_process')
  const base = execFileSync('git', ['-C', preparedTask.repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  let result = await runWorker(preparedTask, '') ?? {
    task: N,
    status: 'blocked',
    summary: 'worker agent returned no result after 3 attempts (killed, errored, or blocked)',
    remaining: [],
    notesFile: preparedTask.notesFile,
  }
  if (result.status === 'partial') {
    const note = `A previous worker finished part of this plan; still remaining: ${result.remaining.join('; ')}. Check the file state before redoing anything.`
    result = (await runWorker(preparedTask, note)) ?? result
  }
  const notesRelative = preparedTask.notesFile.slice(preparedTask.repoRoot.length + 1)
  const changedPaths = execFileSync(
    'git',
    ['-C', preparedTask.repoRoot, 'diff', '--name-only', '-z', `${base}..HEAD`],
    { encoding: 'utf8' },
  ).split('\0').filter(Boolean)
  const fenceViolations = changedPaths.filter(
    (p) => p !== notesRelative && !preparedTask.files.includes(p),
  )
  return { stage: 'implement', ...result, files: preparedTask.files, fenceViolations }
}
```

### Why each piece is exactly this and nothing more

- `base` is captured immediately after `preparedTask` is loaded/confirmed and
  before the first `runWorker` call — this is the commit the worktree was at
  before the implementer touched anything, satisfying "after the implement
  agent commits ... runs `git -C <worktree> diff --name-only <base>..HEAD`."
  `preparedTask.repoRoot` (set in `loadPreparedTask`, line 260 region, to
  `process.cwd()`) is the workflow's working tree for this task — there is no
  separate worktree variable in this file to reuse, and the chain goal
  ("implements ... inside the task's worktree ... then commits") establishes
  that this process already runs inside that worktree, so `repoRoot` is the
  `<worktree>` the brief refers to.
- The fence check runs unconditionally, never gated on the status the worker
  reported. `workerBrief` tells the worker to commit only when everything
  passes, but that is the worker's own promise, and a fence check that trusts
  it is not a check. A worker can commit and then be killed, error out,
  return `null`, or report `"partial"`/`"blocked"`; in every one of those
  cases `HEAD` has still moved and an out-of-fence path must still be
  reported. When no commit happened, `base..HEAD` is simply empty and
  `fenceViolations` comes back `[]`, so running it always costs nothing.
- The diff uses `-z` and splits on NUL rather than newlines. Without `-z`,
  git quotes paths containing spaces or non-ASCII characters, so a legitimately
  owned file with such a name would not match `preparedTask.files` and would be
  reported as a false violation.
- `notesRelative` strips the `repoRoot` prefix from `preparedTask.notesFile`
  (built in `loadPreparedTask` as `` `${repoRoot}/plans/task-${N}-implementation-notes.md` ``)
  so it can be compared against the repo-relative paths `git diff --name-only`
  prints. This implements the brief's explicit exemption: "`plans/task-<N>-implementation-notes.md`
  is exempt from the fence check."
- `preparedTask.files` is read directly (not copied earlier), so any widening
  that happened during the plan stage (or, for the `implement`-only stage
  path, whatever `loadPreparedTask` reads from `tasks.json` right now) is
  what the comparison uses — this is the "live" list, not a stale snapshot.
- The check only reads (`rev-parse`, `diff --name-only`); it never calls
  `reset`, `checkout`, `stash`, `commit --amend`, or invokes `runWorker`
  again, so a violation can never undo or redo work — it only appends to
  `fenceViolations`, which downstream stages (task 141's approval gate) can
  read and act on.
- `fenceViolations` is added as a new field alongside the existing
  `files: preparedTask.files` in the returned object — the same object
  already flows into `results` in every `STAGE_RUNNERS` entry that calls
  `runImplement` (`implement`, and the second half of `plan+implement`), so
  it needs no further plumbing to reach the workflow's return value.

## Other owned-file regions — no edit needed

- `meta.phases` (lines 11-16, specifically line 13: `` { title: `${N} Implement`, detail: 'implement the plan and check the file fence' } ``)
  already describes this behavior in its `detail` string; no wording changes
  are required since the description is already accurate to what this task
  adds.
- No other function in the file reads or constructs `fenceViolations`,
  `runImplement`'s return value, or `results` in a way that this new field
  would break — `STAGE_RUNNERS` (lines 366-376) only ever spreads
  `runImplement()`'s return value into an array; it does not destructure
  specific fields, so adding `fenceViolations` is additive and does not
  require touching `STAGE_RUNNERS`, `WORKER_SCHEMA`, or any other schema in
  the file (those schemas validate the agent's own return shape, not the
  plain-code object this task appends to it after the agent call returns).

## Verification

Two checks, both run from the repo root
`/Users/matkatmusicllc/Programming/taskTools-86` after making the edit above.
Check 1 proves the whole edited file still parses in the shape the real
harness runs it in. Check 2 extracts the real, just-edited `runImplement`
function out of the file and executes it — with `preparedTask` and
`runWorker` stubbed, everything else real — against a disposable git repo,
proving `fenceViolations` is actually produced by the code that ships, not
by a hand-written restatement of it.

### 1. Syntax check (sandbox-shape parse)

This is the same parse technique `tests/tackleTasksRetry.test.ts` already
uses for the sibling workflow files (`parseInSandboxShape`): strip the
`export` keyword (the file is never loaded as an ES module, so plain
`node --check` rejects its `export` + top-level `return`/`await` mix) and
wrap the body in an async IIFE, which is the shape the real agent harness
runs it in.

```
node -e "
const fs = require('fs');
const source = fs.readFileSync('skills/tackle-tasks/task.workflow.js', 'utf8');
const body = source.replace('export const meta', 'const meta');
new Function('args', 'agent', 'log', '(async () => {\n' + body + '\n})()');
console.log('syntax OK');
"
```

Expected output: `syntax OK`, exit code 0. (`new Function` only parses the
body here — it is never called — so `args`/`agent`/`log` need no real
values.) A parse error in the edit prints a `SyntaxError` stack trace and a
non-zero exit code instead.

### 2. Fence-behavior proof (runs the real extracted `runImplement`)

Write this to a throwaway file, e.g. `/tmp/verify-task-138-fence.cjs`, then
run `node /tmp/verify-task-138-fence.cjs` and delete the file afterward —
it is a one-off verification script, not part of this task's owned files.

```js
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const assert = require('assert')

const source = fs.readFileSync('skills/tackle-tasks/task.workflow.js', 'utf8')
const start = source.indexOf('const runImplement = async () => {')
assert.notEqual(start, -1, 'runImplement not found')
const end = source.indexOf('\n}\n', start)
assert.notEqual(end, -1, 'runImplement has no closing brace')
const runImplementSrc = source.slice(start, end + 3)

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-check-'))
execFileSync('git', ['-C', TMPDIR, 'init', '-q'])
fs.mkdirSync(path.join(TMPDIR, 'plans'))
fs.writeFileSync(path.join(TMPDIR, 'plans', '.gitkeep'), 'init\n')
execFileSync('git', ['-C', TMPDIR, 'add', '-A'])
execFileSync('git', ['-C', TMPDIR, 'commit', '-q', '-m', 'init'])
const beforeHead = execFileSync('git', ['-C', TMPDIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

const preparedTask = {
  repoRoot: TMPDIR,
  files: ['owned.txt'],
  notesFile: path.join(TMPDIR, 'plans', 'task-999-implementation-notes.md'),
}

// Fake worker always commits, then reports whatever CASE says.
const CASE = process.argv[2] ?? 'done'
const runWorker = async () => {
  fs.writeFileSync(path.join(TMPDIR, 'owned.txt'), 'a\n')
  fs.writeFileSync(preparedTask.notesFile, 'b\n')
  fs.writeFileSync(path.join(TMPDIR, 'unowned.txt'), 'c\n')
  execFileSync('git', ['-C', TMPDIR, 'add', '-A'])
  execFileSync('git', ['-C', TMPDIR, 'commit', '-q', '-m', 'implement'])
  if (CASE === 'null') return null
  return { task: 999, status: CASE, summary: 'x', remaining: [], notesFile: preparedTask.notesFile }
}

const N = 999
const log = () => {}
const build = new Function('preparedTask', 'runWorker', 'log', 'N', `${runImplementSrc}\nreturn runImplement`)
const runImplement = build(preparedTask, runWorker, log, N)

runImplement().then((result) => {
  assert.deepEqual(result.fenceViolations, ['unowned.txt'])
  assert.equal(result.status, CASE === 'null' ? 'blocked' : CASE)
  const afterHead = execFileSync('git', ['-C', TMPDIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.notEqual(beforeHead, afterHead, 'the worker\'s own commit should exist')
  const stillAtWorkerCommit = execFileSync('git', ['-C', TMPDIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(afterHead, stillAtWorkerCommit, 'the fence check must not add, amend, or move any commit')
  console.log('fence check OK, fenceViolations =', result.fenceViolations)
}).finally(() => {
  fs.rmSync(TMPDIR, { recursive: true, force: true })
})
```

Run it three times, once per worker outcome — the fence result must be
identical every time, because the fence does not trust what the worker says:

```
node fence-check.mjs done
node fence-check.mjs blocked
node fence-check.mjs null
```

Expected output for all three: `fence check OK, fenceViolations = [ 'unowned.txt' ]`,
exit code 0. The `blocked` and `null` runs are the ones that matter most — the
worker committed and then reported failure, and the violation must still be
reported.

Run against the file before this task's edit, all three must
fail the first `assert.deepEqual` with `actual: undefined` (there is no
`fenceViolations` field yet) — that failure is the negative control proving
this check actually exercises the new code, not a tautology.
