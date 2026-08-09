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
