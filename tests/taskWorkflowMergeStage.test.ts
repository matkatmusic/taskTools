import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { compileFunction, constants as vmConstants } from 'node:vm'
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from '../scripts/repositoryManifest.ts'

const REPO_ROOT = process.cwd()
const WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT, 'skills/tackle-tasks/task.workflow.js'), 'utf8')
  .replace('export const meta', 'const meta')

type WorkflowRunner = (argsJson: string, log: (...values: unknown[]) => void, agent: (...values: unknown[]) => Promise<unknown>) => Promise<{
  task: number
  stage: string
  results: Array<Record<string, unknown>>
}>

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

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

// mergeTaskDeepestFirst needs a package.json test script or it reports the parent layer untested and refuses to merge.
const addTestScript = (repoPath: string, command: string) => {
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { test: command } }))
  git(repoPath, 'add', 'package.json')
  git(repoPath, 'commit', '-q', '-m', 'add test script')
}

const makeRootWithWorktree = (taskNumber: number, { testScript = 'true' }: { testScript?: string } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'task-workflow-merge-root-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'README.md'), 'root\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-q', '-m', 'init')
  addTestScript(root, testScript)
  const sourceBranch = 'main'
  const baseOid = git(root, 'rev-parse', sourceBranch)
  const operationBranch = `task-${taskNumber}`
  const worktreePath = join(tmpdir(), `task-workflow-merge-wt-${randomUUID()}`)
  git(root, 'worktree', 'add', '-q', '-b', operationBranch, worktreePath, sourceBranch)
  mkdirSync(join(worktreePath, 'plans'), { recursive: true })
  // A real task worktree already has scripts/; this throwaway fixture repo doesn't.
  symlinkSync(join(REPO_ROOT, 'scripts'), join(worktreePath, 'scripts'))
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
      operationBranch,
      childOccurrenceIds: [],
      testState: 'untested',
    }],
  }
  return { root, worktreePath, repositoryManifest }
}

const removeFixture = (root: string, worktreePath: string) => {
  rmSync(worktreePath, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
}

// A real merge lap closes the task, so the main repo needs both task files or closeTasks throws.
const seedTaskFiles = (root: string, taskNumber: number) => {
  mkdirSync(join(root, '.taskTools'), { recursive: true })
  writeFileSync(join(root, '.taskTools', 'tasks.json'), JSON.stringify([{ taskNumber, title: 'fixture', files: [], blockedBy: [] }]))
  writeFileSync(join(root, '.taskTools', 'completedTasks.json'), '[]')
}

// A real task worktree already has its own checked-out .taskTools/tasks.json; loadPreparedTask reads it from cwd.
const seedWorktreeTaskFile = (worktreePath: string, taskNumber: number) => {
  mkdirSync(join(worktreePath, '.taskTools'), { recursive: true })
  writeFileSync(join(worktreePath, '.taskTools', 'tasks.json'), JSON.stringify([{ taskNumber, title: 'fixture', files: [], blockedBy: [] }]))
}

test('merge stage deletes plan and brief, keeps notes, closes the task against the merged hash, and removes the worktree last', async () => {
  const taskNumber = 9001
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'plans', `task-${taskNumber}-implementation-notes.md`), 'notes\n')
    git(worktreePath, 'add', `plans/task-${taskNumber}-implementation-notes.md`)
    git(worktreePath, 'commit', '-q', '-m', 'implementation notes')

    writeFileSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`), 'plan\n')
    writeFileSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`), 'brief\n')
    git(worktreePath, 'add', `plans/task-${taskNumber}-plan.md`, `plans/brief-${taskNumber}.md`)
    git(worktreePath, 'commit', '-q', '-m', 'plan and brief')

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest })
    assert.equal(result.stage, 'merge')
    assert.equal(result.task, taskNumber)
    const merged = result.results[0] as { status: string, mergedCommitHash: string, closed: number[] }
    assert.equal(merged.status, 'merged')
    assert.deepEqual(merged.closed, [taskNumber])

    assert.equal(git(root, 'show', `main:plans/task-${taskNumber}-implementation-notes.md`), 'notes')
    assert.throws(() => git(root, 'show', `main:plans/task-${taskNumber}-plan.md`))
    assert.throws(() => git(root, 'show', `main:plans/brief-${taskNumber}.md`))

    // The archived record must carry the commit the source branch actually points at.
    assert.equal(merged.mergedCommitHash, git(root, 'rev-parse', 'main'))
    const stillOpen = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8'))
    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(stillOpen, [])
    assert.deepEqual(archived.map((task: { taskNumber: number }) => task.taskNumber), [taskNumber])
    assert.deepEqual(archived[0].commitHashes, [merged.mergedCommitHash])

    // removeWorktreeAndBranch runs last, after the verified close.
    assert.equal(existsSync(worktreePath), false)
  } finally {
    removeFixture(root, worktreePath)
  }
})

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

test('rebase stage: a failing rebase command blocks the lap before any agent runs', async () => {
  const taskNumber = 9007
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  seedWorktreeTaskFile(worktreePath, taskNumber)
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
  seedWorktreeTaskFile(worktreePath, taskNumber)
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
  seedWorktreeTaskFile(worktreePath, taskNumber)
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
