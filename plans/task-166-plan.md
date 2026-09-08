# Task 166 plan: thread the prepared task-N worktree into the generated workflows (C86-01)

## Root cause

`scripts/prepareTasks.ts` already builds a per-task worktree and exposes it as
`groups[].worktree` (type `PreparedGroup.worktree`, set at
`buildWorkflowArguments` line 171 via `createWorktreeForGroup(repoRoot, group)`).
Nothing downstream reads it:

- `scripts/tackleTasksBrief.ts` tells the orchestrator to launch
  `task.workflow.js` with `{task, typecheckCommand}` for plan+implement and
  `{task: taskNumber, stage, repositoryManifest}` for rebase-test/merge —
  neither object carries `worktree`.
- `skills/tackle-tasks/task.workflow.js` derives `repoRoot` from
  `process.cwd()` in `loadPreparedTask()` (used by plan/implement/rebase-test)
  and again in `runMerge()`, and resolves `./scripts/*.ts` helper imports as
  bare relative specifiers against the compiled script's own file location —
  which in production is `skills/tackle-tasks/`, where no `scripts/`
  subdirectory exists.

The fix threads `worktree` from `prepareTasks` through `tackleTasksBrief`'s
launch-argument documentation into `task.workflow.js`, and inside
`task.workflow.js` replaces every `process.cwd()` read and every bare
`./scripts/*.ts` import with an explicit path built from the passed-in
`worktree` argument (mirroring the pattern `runMerge()` already uses for its
own imports: `pathToFileURL(join(repoRoot, 'scripts/X.ts')).href`). No
`process.chdir` is introduced anywhere.

## File-by-file plan

### scripts/prepareTasks.ts — no edit

`PreparedGroup` (line 20-26) already declares `worktree: string`, and
`buildWorkflowArguments` (lines 156-183) already sets
`worktree: createWorktreeForGroup(repoRoot, group)` for every task's group
(line 171). The pipeline-args JSON `prepareTasks.ts` prints already carries
`groups[].worktree` for every task. The defect is entirely downstream (the
value is produced but never read), so this file needs no change.

### scripts/tackleTasksBrief.ts — 2 edits

**Edit 1** — add `worktree` to the plan+implement launch-argument
instructions. Exact current text (inside the `tackleTasksBrief` template
literal, backticks escaped as `\``):

```
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
```

becomes:

```
Args for each launch: \`{task, typecheckCommand, worktree}\`, where \`task\`
is that entry's \`tasks[0].number\`, \`typecheckCommand\` is the value from
the pipeline args above, and \`worktree\` is that same entry's \`worktree\`.
For example, for the group whose \`tasks[0].number\` is \`268\` and whose
\`worktree\` is \`/tmp/taskTools-wt/repo/task-268\`:

\`\`\`json
{"task": 268, "typecheckCommand": "npx tsc --noEmit", "worktree": "/tmp/taskTools-wt/repo/task-268"}
\`\`\`

Pass nothing else. \`task.workflow.js\` reads only \`task\`, \`stage\`,
\`typecheckCommand\`, \`worktree\`, \`workerModel\`, and \`maxRounds\` from its
args — it loads everything else about the task (its brief, plan path, owned
files) itself, straight from the worktree's own checkout of tasks.json.
```

**Edit 2** — add `worktree` to the merge-queue's step-1 launch instructions.
Exact current substring (this is one long source line, backticks escaped as
`\``):

```
Otherwise, launch \`${taskWorkflowPath}\` as a background workflow with args \`{task: taskNumber, stage, repositoryManifest}\` — \`repositoryManifest\` is the pipeline args value from above — add \`taskNumber → stage\` to \`outstandingEntries\`, and go back to step 1.
```

becomes:

```
Otherwise, launch \`${taskWorkflowPath}\` as a background workflow with args \`{task: taskNumber, stage, repositoryManifest, worktree}\` — \`repositoryManifest\` is the pipeline args value from above and \`worktree\` is the \`worktree\` field of the \`groups\` entry whose \`tasks[0].number\` equals \`taskNumber\` — add \`taskNumber → stage\` to \`outstandingEntries\`, and go back to step 1.
```

(Only this substring changes; the rest of that source line, and the rest of
the surrounding paragraph, is untouched.)

### skills/tackle-tasks/task.workflow.js — 5 edits

**Edit 1** — declare and guard the worktree argument. Current text (lines
1-7):

```
const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const N = ARGS.task
const STAGE = ARGS.stage ?? 'plan+implement'
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
const WORKER_MODEL = ARGS.workerModel
const MAX_FIX_ROUNDS = ARGS.maxRounds ?? 3
const MAX_REBASE_FIX_ROUNDS = ARGS.maxRebaseFixRounds ?? 3
```

becomes:

```
const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const N = ARGS.task
const STAGE = ARGS.stage ?? 'plan+implement'
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
const WORKER_MODEL = ARGS.workerModel
const MAX_FIX_ROUNDS = ARGS.maxRounds ?? 3
const MAX_REBASE_FIX_ROUNDS = ARGS.maxRebaseFixRounds ?? 3
const WORKTREE = ARGS.worktree
if (!WORKTREE) throw new Error('task.workflow.js: no "worktree" in args; every stage must run inside the prepared task worktree')
```

**Edit 2** — `loadPreparedTask`: stop reading `process.cwd()`, resolve its two
helper imports against `WORKTREE` instead of a bare relative specifier.
Current text (lines 330-337):

```
const loadPreparedTask = async () => {
  const { resolveTaskFiles, readTaskFile } = await import('./scripts/taskFiles.ts')
  const { writeTaskBriefFile } = await import('./scripts/prepareTasks.ts')
  const repoRoot = process.cwd()
  const pair = resolveTaskFiles(repoRoot)
  const task = readTaskFile(pair.tasksPath).find((entry) => entry.taskNumber === N)
  if (!task) throw new Error(`task.workflow.js: task ${N} not found in tasks.json`)
  const briefFile = writeTaskBriefFile(task, repoRoot)
```

becomes:

```
const loadPreparedTask = async () => {
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { resolveTaskFiles, readTaskFile } = await import(pathToFileURL(join(WORKTREE, 'scripts/taskFiles.ts')).href)
  const { writeTaskBriefFile } = await import(pathToFileURL(join(WORKTREE, 'scripts/prepareTasks.ts')).href)
  const repoRoot = WORKTREE
  const pair = resolveTaskFiles(repoRoot)
  const task = readTaskFile(pair.tasksPath).find((entry) => entry.taskNumber === N)
  if (!task) throw new Error(`task.workflow.js: task ${N} not found in tasks.json`)
  const briefFile = writeTaskBriefFile(task, repoRoot)
```

(The rest of `loadPreparedTask`, lines 338-348, is unchanged: it already
returns `repoRoot` as a field, and every other line already reads only
`repoRoot`, `task`, and local variables.)

**Edit 3** — `runPlan`: resolve its two re-imports of `taskFiles.ts` /
`prepareTasks.ts` the same way. Current text (lines 350-355):

```
const runPlan = async () => {
  log(`task ${N}: plan stage`)
  preparedTask = await loadPreparedTask()
  const { execFileSync } = await import('node:child_process')
  const { readTaskFile } = await import('./scripts/taskFiles.ts')
  const { writeTaskBriefFile } = await import('./scripts/prepareTasks.ts')
```

becomes:

```
const runPlan = async () => {
  log(`task ${N}: plan stage`)
  preparedTask = await loadPreparedTask()
  const { execFileSync } = await import('node:child_process')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { readTaskFile } = await import(pathToFileURL(join(WORKTREE, 'scripts/taskFiles.ts')).href)
  const { writeTaskBriefFile } = await import(pathToFileURL(join(WORKTREE, 'scripts/prepareTasks.ts')).href)
```

(The line after this block, `const result = await retryAgent(...)`, and
everything else in `runPlan`, is unchanged — it already only reads
`preparedTask.repoRoot`/`preparedTask.pair`, which now equal `WORKTREE`.)

**Edit 4** — `runRebaseTest`: resolve its two `./scripts/*.ts` imports the
same way. Current text (lines 549-555):

```
const runRebaseTest = async () => {
  log(`task ${N}: rebase-test stage`)
  if (!preparedTask) preparedTask = await loadPreparedTask()
  const { execFileSync } = await import('node:child_process')
  const { join, relative } = await import('node:path')
  const { rebaseSubmoduleLayersDeepestFirst, rebaseParentOntoSourceAndTest, uncommittedChangedFiles } = await import('./scripts/mergeTaskWorktrees.ts')
  const { createEmptyResolutionManifest } = await import('./scripts/resolutionRequests.ts')
```

becomes:

```
const runRebaseTest = async () => {
  log(`task ${N}: rebase-test stage`)
  if (!preparedTask) preparedTask = await loadPreparedTask()
  const { execFileSync } = await import('node:child_process')
  const { join, relative } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { rebaseSubmoduleLayersDeepestFirst, rebaseParentOntoSourceAndTest, uncommittedChangedFiles } = await import(pathToFileURL(join(WORKTREE, 'scripts/mergeTaskWorktrees.ts')).href)
  const { createEmptyResolutionManifest } = await import(pathToFileURL(join(WORKTREE, 'scripts/resolutionRequests.ts')).href)
```

(The next line, `const worktreePath = preparedTask.repoRoot`, is unchanged —
`preparedTask.repoRoot` is now `WORKTREE` via edit 2, so this already gets
the right value.)

**Edit 5** — `runMerge`: stop reading `process.cwd()`. Current text (lines
670-672):

```
const runMerge = async () => {
  log(`task ${N}: merge stage`)
  const repoRoot = process.cwd()
```

becomes:

```
const runMerge = async () => {
  log(`task ${N}: merge stage`)
  const repoRoot = WORKTREE
```

(Everything else in `runMerge`, including its existing
`pathToFileURL(join(repoRoot, 'scripts/X.ts')).href` imports and its use of
`rootOccurrence.checkoutPath` as `mainRepoRoot` for `closeTasks`, is
unchanged — those already resolve correctly once `repoRoot` is the worktree.)

No other `process.cwd()`, `chdir`, or `./scripts/*.ts` occurrence exists in
this file (confirmed by grepping the file for `process.cwd`, `chdir`, and
`./scripts/` — the only hits are the 5 sites edited above).

### tests/prepareTasks.test.ts — no edit

This file only calls `prepareTasks.ts` functions directly
(`writeTaskBriefFile`, `createWorktreeForGroup`, `buildWorkflowArguments`,
`selectRequestedTasks`, `generateRunId`, `resolveMergeScriptPath`). It never
invokes `task.workflow.js` or `tackleTasksBrief.ts`, and none of those four
functions' signatures or behavior change in this plan (see "no edit" above
for `prepareTasks.ts`). Its existing assertions, including
`test_buildWorkflowArgumentsGivesEachTaskItsOwnWorktreeAndBranchAsASingletonGroup`
(lines 252-269), already exercise and confirm `groups[].worktree` is
produced; nothing here needs to change.

### tests/runMergePhase.test.ts — 1 edit

Update `runTaskWorkflowStage` to pass `worktree` explicitly in `args` and
stop chdir'ing, using the real production script path for `filename` (no
filename relocation). Current text (lines 189-203):

```
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
```

becomes:

```
// Mirrors runMergeStage in tests/taskWorkflowMergeStage.test.ts, driving the same task.workflow.js source.
const runTaskWorkflowStage = async (worktreePath: string, args: Record<string, unknown>) => {
    const fn = compileFunction(
        `return (async () => { 'use strict'\n${TASK_WORKFLOW_SOURCE} })()`,
        ["args", "log", "agent"],
        { filename: join(REPO_ROOT, "skills/tackle-tasks/task.workflow.js"), importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    ) as TaskWorkflowRunner;
    return await fn(JSON.stringify({ worktree: worktreePath, ...args }), () => {}, throwingAgent);
};
```

`REPO_ROOT` is already declared above this function (line 180:
`const REPO_ROOT = process.cwd();`), so it is in scope. No call site of
`runTaskWorkflowStage` (the single call at line 265 and the one at line 272)
needs to change — the helper now injects `worktree: worktreePath`
automatically for every caller. This also means the existing
`test_endToEndQueueDrivesARealTaskThroughRebaseTestThenMergeAndReportsItMerged`
test (lines 252-289) becomes a chdir-free, real-filename production-shaped
test of the rebase-test → merge chain as a side effect of this one edit.

### tests/taskWorkflowMergeStage.test.ts — 3 edits

**Edit 1** — add an import for `createWorktreeForGroup`, used by the new
test below. Current text (line 9, the last import line):

```
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from '../scripts/repositoryManifest.ts'
```

becomes:

```
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from '../scripts/repositoryManifest.ts'
import { createWorktreeForGroup } from '../scripts/prepareTasks.ts'
```

**Edit 2** — update `runMergeStage` to pass `worktree` explicitly and stop
chdir'ing, using the real production script path for `filename`. Current
text (lines 21-40):

```
const throwingAgent = async () => { throw new Error('merge stage must not call an agent') }

// filename resolves relative imports (e.g. './scripts/taskFiles.ts') against the worktree, not this test file.
const runMergeStage = async (worktreePath: string, args: Record<string, unknown>, agentImpl: (...values: unknown[]) => Promise<unknown> = throwingAgent) => {
  const fn = compileFunction(
    `return (async () => { 'use strict'\n${WORKFLOW_SOURCE} })()`,
    ['args', 'log', 'agent'],
    { filename: join(worktreePath, 'task.workflow.js'), importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  ) as WorkflowRunner
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

becomes:

```
const throwingAgent = async () => { throw new Error('merge stage must not call an agent') }

// filename is the real script path; imports resolve against args.worktree, not cwd or a relocated filename.
const runMergeStage = async (worktreePath: string, args: Record<string, unknown>, agentImpl: (...values: unknown[]) => Promise<unknown> = throwingAgent) => {
  const fn = compileFunction(
    `return (async () => { 'use strict'\n${WORKFLOW_SOURCE} })()`,
    ['args', 'log', 'agent'],
    { filename: join(REPO_ROOT, 'skills/tackle-tasks/task.workflow.js'), importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  ) as WorkflowRunner
  return await fn(
    JSON.stringify({ worktree: worktreePath, ...args }),
    () => {},
    agentImpl,
  )
}
```

`REPO_ROOT` is already declared above this function (line 11:
`const REPO_ROOT = process.cwd()`), so it is in scope. No existing call site
of `runMergeStage` in this file needs to change — every one of them keeps
passing `worktreePath` as its first argument, and the helper now injects
`worktree: worktreePath` into the args automatically. This makes every
existing test in this file (the 9001, 9002, 9003, 9004, 9005, 9006, 9007
cases) a chdir-free, real-filename test as a side effect of this one edit.

**Edit 3** — append one new test proving the full prepare → launch →
workflow chain: `prepareTasks.createWorktreeForGroup` builds the worktree,
and `task.workflow.js` merges it using only the passed `worktree` argument,
with `process.cwd()` never touched and the real script filename in use.
Append after the file's final line (the closing `})` of the last existing
test, currently at end-of-file line 433-434):

```

test('production-shaped: the worktree prepareTasks.createWorktreeForGroup produces is what task.workflow.js merges, with no chdir and the real script path', async () => {
  const taskNumber = 9008
  const root = mkdtempSync(join(tmpdir(), 'task-workflow-prepare-root-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'README.md'), 'root\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-q', '-m', 'init')
  addTestScript(root, 'true')
  const sourceBranch = 'main'
  const baseOid = git(root, 'rev-parse', sourceBranch)
  const worktreePath = createWorktreeForGroup(root, { groupId: taskNumber, taskNumbers: [taskNumber], filePaths: [], scope: 'declared' })
  symlinkSync(join(REPO_ROOT, 'scripts'), join(worktreePath, 'scripts'))
  mkdirSync(join(worktreePath, 'plans'), { recursive: true })
  const repositoryManifest: RepositoryManifest = {
    version: REPOSITORY_MANIFEST_VERSION,
    occurrences: [{
      occurrenceId: '',
      checkoutPath: root,
      parentOccurrenceId: null,
      pathInParent: null,
      gitlinkOid: null,
      depth: 0,
      originUrl: '',
      baseBranch: sourceBranch,
      baseOid,
      operationBranch: `task-${taskNumber}`,
      childOccurrenceIds: [],
      testState: 'untested',
    }],
  }
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`), 'plan\n')
    writeFileSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`), 'brief\n')
    git(worktreePath, 'add', `plans/task-${taskNumber}-plan.md`, `plans/brief-${taskNumber}.md`)
    git(worktreePath, 'commit', '-q', '-m', 'plan and brief')

    const cwdBefore = process.cwd()
    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest })
    assert.equal(process.cwd(), cwdBefore)

    const merged = result.results[0] as { status: string, closed: number[] }
    assert.equal(merged.status, 'merged')
    assert.deepEqual(merged.closed, [taskNumber])
    assert.equal(existsSync(worktreePath), false)
  } finally {
    removeFixture(root, worktreePath)
  }
})
```

This test never calls `process.chdir`, never relocates the compiled script
under the worktree, builds the worktree the same way real
`prepareTasks.ts` does (`createWorktreeForGroup`), and drives it through
`task.workflow.js`'s merge stage purely via the `worktree` argument —
directly demonstrating that `groups[].worktree` is consumed downstream,
which is the defect this task fixes. `removeFixture` (already defined in
this file, lines 90-93) tolerates `worktreePath` already having been removed
by a successful merge, since `rmSync(..., { force: true })` does not throw
on a missing path.

## Known out-of-scope risk

`tests/tackleTasksBrief.test.ts` exists in this repository (confirmed by
`rg -l "task\.workflow\.js"` listing it) but is not in this task's owned
files, so it cannot be read or edited under this plan. If that file asserts
the exact prose of the launch-argument section changed in
`scripts/tackleTasksBrief.ts` edit 1/edit 2 above, it may need a matching
follow-up edit outside this task's fence. This plan does not touch that
file; the verification step below will surface whether it needs one.

## Verification

Run, from the repo root `/Users/matkatmusicllc/Programming/taskTools-86`:

```
npx tsc --noEmit
```
Expected: no new type errors introduced by the edits above (the only new
identifiers are `WORKTREE`, `join`, and `pathToFileURL`, all either already
declared elsewhere in their own scope or freshly declared before use).

```
npm test
```
Expected: every test in `tests/prepareTasks.test.ts`,
`tests/runMergePhase.test.ts`, and `tests/taskWorkflowMergeStage.test.ts`
passes, including the new `production-shaped: the worktree
prepareTasks.createWorktreeForGroup produces...` test. If
`tests/tackleTasksBrief.test.ts` fails, that is the known out-of-scope risk
above, not a defect in these edits — it is not this task's file to fix.

```
node --test tests/taskWorkflowMergeStage.test.ts tests/runMergePhase.test.ts tests/prepareTasks.test.ts
```
Expected: all tests in these three files report ok, with the new test
specifically confirming `process.cwd()` before and after the merge call are
identical (proving no chdir occurred) and that the task merged successfully
using only the `worktree` argument.
