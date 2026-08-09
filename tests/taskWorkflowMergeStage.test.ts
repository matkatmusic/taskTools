import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from '../scripts/repositoryManifest.ts'

const REPO_ROOT = process.cwd()
const WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT, 'skills/tackle-tasks/task.workflow.js'), 'utf8')
  .replace('export const meta', 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...params: string[]
) => (argsJson: string, log: (...values: unknown[]) => void, agent: (...values: unknown[]) => Promise<unknown>) => Promise<{
  task: number
  stage: string
  results: Array<Record<string, unknown>>
}>

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

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

// mergeTaskDeepestFirst needs a package.json test script or it reports the parent layer untested and refuses to merge.
const addPassingTestScript = (repoPath: string) => {
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }))
  git(repoPath, 'add', 'package.json')
  git(repoPath, 'commit', '-q', '-m', 'add test script')
}

const makeRootWithWorktree = (taskNumber: number) => {
  const root = mkdtempSync(join(tmpdir(), 'task-workflow-merge-root-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'README.md'), 'root\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-q', '-m', 'init')
  addPassingTestScript(root)
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
