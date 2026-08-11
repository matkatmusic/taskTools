import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { compileFunction } from 'node:vm'
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from '../scripts/repositoryManifest.ts'
import { attachOperationBranch, createWorktreeForGroup, loadRepositoryManifest } from '../scripts/prepareTasks.ts'
import { buildMergeReport, consumeTaskWorkflowResult, createMergeQueue, enqueueApprovedTask, recordStageOutcome, type TaskWorkflowEnvelope } from '../scripts/runMergePhase.ts'

const REPO_ROOT = process.cwd()
const WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT, 'skills/tackle-tasks/tackle-tasks.workflow.js'), 'utf8')
  .replace('export const meta', 'const meta')
const EMITTER_PATH = join(REPO_ROOT, 'scripts/tackle-tasks_AgentPromptEmitter.ts')

type AgentImpl = (prompt: string, options: { label: string }) => Promise<unknown>

type WorkflowRunner = (argsJson: string, log: (...values: unknown[]) => void, agent: AgentImpl) => Promise<{
  task: number
  stage: string
  results: Array<Record<string, unknown>>
}>

const throwingAgent = async () => { throw new Error('merge stage must not call an agent') }

// Every agent() prompt from tackle-tasks.workflow.js is one `node <emitter> <task> <role> <<'TT_PAYLOAD'` command.
const EMITTER_COMMAND_RE = /node (\S+) (\d+) (\S+) <<'TT_PAYLOAD'\n(.*)\nTT_PAYLOAD/
const DRIVER_RESULT_PREFIX = 'Return exactly this JSON as your structured result, with no other keys added or removed:\n'

// Driver roles resolve via the real emitter; judgment roles use the stand-in.
const agentThatRunsRealEmitterAndScriptsJudgment = (scriptedJudgment: AgentImpl): AgentImpl => async (prompt, options) => {
  const match = prompt.match(EMITTER_COMMAND_RE)
  if (!match) throw new Error(`prompt has no embedded emitter command: ${prompt.slice(0, 200)}`)
  const [, emitterPath, taskArg, role, payloadJson] = match
  const output = execFileSync('node', [emitterPath!, taskArg!, role!], { input: payloadJson, encoding: 'utf8' })
  if (output.startsWith(DRIVER_RESULT_PREFIX)) return JSON.parse(output.slice(DRIVER_RESULT_PREFIX.length).trim())
  return scriptedJudgment(prompt, options)
}

// filename is the real script path; imports resolve against args.worktree, not cwd or a relocated filename.
const runMergeStage = async (worktreePath: string, args: Record<string, unknown>, judgmentAgent: AgentImpl = throwingAgent) => {
  const fn = compileFunction(
    `return (async () => { 'use strict'\n${WORKFLOW_SOURCE} })()`,
    ['args', 'log', 'agent'],
    { filename: join(REPO_ROOT, 'skills/tackle-tasks/tackle-tasks.workflow.js') },
  ) as WorkflowRunner
  return await fn(
    JSON.stringify({ worktree: worktreePath, agentPromptEmitterPath: EMITTER_PATH, ...args }),
    () => {},
    agentThatRunsRealEmitterAndScriptsJudgment(judgmentAgent),
  )
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

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
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
    const first = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const firstOutcome = first.results[0] as { status: string, mergedCommitHash: string, closeError: string }
    assert.equal(firstOutcome.status, 'merged-but-not-closed')
    assert.notEqual(firstOutcome.mergedCommitHash, headBeforeMerge)
    assert.equal(git(root, 'rev-parse', 'main'), firstOutcome.mergedCommitHash)
    assert.equal(existsSync(worktreePath), true)
    assert.equal(existsSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`)), false)
    assert.equal(existsSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`)), false)
    assert.match(firstOutcome.closeError, /close failure/)

    let queue = createMergeQueue()
    queue = enqueueApprovedTask(queue, taskNumber)
    queue = recordStageOutcome(queue, taskNumber, 'rebase-test', { status: 'success' })
    const consumed = consumeTaskWorkflowResult(queue, first as TaskWorkflowEnvelope)
    assert.equal(consumed.kind, 'queue')
    if (consumed.kind !== 'queue') return assert.fail('expected queue result')
    assert.deepEqual(consumed.queue.merged, [taskNumber])
    assert.equal(consumed.queue.mergedNotClosed.length, 1)
    assert.equal(consumed.queue.mergedNotClosed[0]!.commitHash, firstOutcome.mergedCommitHash)
    assert.equal(consumed.queue.mergedNotClosed[0]!.lastFailure, firstOutcome.closeError)

    const headBeforeRetry = git(root, 'rev-parse', 'main')
    const worktreeHeadBeforeRetry = git(worktreePath, 'rev-parse', 'HEAD')
    const second = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
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

// C86-14: an unrelated later commit on main must not get archived as this task's hash.
test('a merged-but-not-closed retry archives the original merge commit even after main advances in between', async () => {
  const taskNumber = 9010
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

    const first = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const firstOutcome = first.results[0] as { status: string, mergedCommitHash: string }
    assert.equal(firstOutcome.status, 'merged-but-not-closed')

    rmSync(join(root, '.taskTools', 'completedTasks.json'), { recursive: true, force: true })
    writeFileSync(join(root, '.taskTools', 'completedTasks.json'), '[]')

    writeFileSync(join(root, 'advanced-by-another-task.txt'), 'another task merged later\n')
    git(root, 'add', 'advanced-by-another-task.txt')
    git(root, 'commit', '-q', '-m', 'unrelated later merge advances main')

    const second = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const secondOutcome = second.results[0] as { status: string, mergedCommitHash: string, closed: number[] }
    assert.equal(secondOutcome.status, 'merged')
    assert.deepEqual(secondOutcome.closed, [taskNumber])
    assert.equal(secondOutcome.mergedCommitHash, firstOutcome.mergedCommitHash)
    assert.notEqual(secondOutcome.mergedCommitHash, git(root, 'rev-parse', 'main'))

    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(archived.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.deepEqual(archived[0].commitHashes, [firstOutcome.mergedCommitHash])
  } finally {
    removeFixture(root, worktreePath)
  }
})

test('a real root merge conflict produces a concrete final-report reason naming the conflicted file', async () => {
  const taskNumber = 9021
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'conflicted-file.ts'), 'export const value = "task"\n')
    git(worktreePath, 'add', 'conflicted-file.ts')
    git(worktreePath, 'commit', '-q', '-m', 'task adds conflicted file')

    writeFileSync(join(root, 'conflicted-file.ts'), 'export const value = "root"\n')
    git(root, 'add', 'conflicted-file.ts')
    git(root, 'commit', '-q', '-m', 'root adds conflicted file')

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const outcome = result.results[0] as { status: string, lastFailure: string }
    assert.equal(outcome.status, 'parent-conflicted')
    assert.match(outcome.lastFailure, /rebase conflict/)
    assert.match(outcome.lastFailure, /conflicted-file\.ts/)

    let queue = createMergeQueue()
    queue = enqueueApprovedTask(queue, taskNumber)
    queue = recordStageOutcome(queue, taskNumber, 'rebase-test', { status: 'success' })
    const consumed = consumeTaskWorkflowResult(queue, result as TaskWorkflowEnvelope)
    assert.equal(consumed.kind, 'queue')
    if (consumed.kind !== 'queue') return assert.fail('expected queue result')
    const report = buildMergeReport(consumed.queue)
    assert.equal(typeof report.unmerged[0]!.lastFailure, 'string')
    assert.match(report.unmerged[0]!.lastFailure, /rebase conflict/)
    assert.match(report.unmerged[0]!.lastFailure, /conflicted-file\.ts/)
  } finally {
    removeFixture(root, worktreePath)
  }
})

// Locking the worktree makes `git worktree remove --force` fail without touching branch deletion.
test('merge stage: a locked worktree fails final cleanup with a warning-only outcome after a successful close', async () => {
  const taskNumber = 9022
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    git(root, 'worktree', 'lock', worktreePath)

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const outcome = result.results[0] as { status: string, cleanupWarning?: string, closed: number[] }
    assert.equal(outcome.status, 'merged')
    assert.equal(typeof outcome.cleanupWarning, 'string')
    assert.notEqual(outcome.cleanupWarning!.length, 0)
    assert.equal('lastFailure' in outcome, false)
    assert.deepEqual(outcome.closed, [taskNumber])

    let queue = createMergeQueue()
    queue = enqueueApprovedTask(queue, taskNumber)
    queue = recordStageOutcome(queue, taskNumber, 'rebase-test', { status: 'success' })
    const consumed = consumeTaskWorkflowResult(queue, result as TaskWorkflowEnvelope)
    assert.equal(consumed.kind, 'queue')
    if (consumed.kind !== 'queue') return assert.fail('expected queue result')
    assert.deepEqual(consumed.queue.merged, [taskNumber])
    const report = buildMergeReport(consumed.queue)
    assert.deepEqual(report.unmerged, [])
    assert.deepEqual(report.mergedNotClosed, [])
  } finally {
    try { git(root, 'worktree', 'unlock', worktreePath) } catch { /* already gone */ }
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
    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'rebase-test', repositoryManifest, sourceRoot: root })

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
    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'rebase-test', repositoryManifest, sourceRoot: root }, conflictAgent)

    const outcome = result.results[0] as { status: string, lastFailure: string }
    assert.equal(outcome.status, 'blocked')
    assert.match(outcome.lastFailure, /unresolved merge conflict in root/)
    assert.match(outcome.lastFailure, /README\.md/)
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
      { task: taskNumber, stage: 'rebase-test', repositoryManifest, maxRebaseFixRounds: 1, sourceRoot: root },
      fixAgent,
    )

    const outcome = result.results[0] as { status: string, lastFailure: string, failedCheck: string }
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.lastFailure, 'complete-suite still red after MAX_REBASE_FIX_ROUNDS')
    assert.equal(outcome.failedCheck, 'complete-suite')
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

test('merge stage refuses to guess when a merge intent exists but the merge record is missing', async () => {
  const taskNumber = 9026
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    // Simulate interruption after the source merge lands but before recordMergedCommit runs.
    const taskOid = git(worktreePath, 'rev-parse', `task-${taskNumber}`)
    git(root, 'update-ref', `refs/taskTools/merge-intents/task-${taskNumber}`, taskOid)
    git(root, 'merge', '--no-ff', `task-${taskNumber}`, '-m', `merge task-${taskNumber}`)

    // A later task advances main, as production would between the crash and this retry.
    writeFileSync(join(root, 'unrelated.txt'), 'later task\n')
    git(root, 'add', 'unrelated.txt')
    git(root, 'commit', '-q', '-m', 'unrelated later merge')

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })

    let queue = createMergeQueue()
    queue = enqueueApprovedTask(queue, taskNumber)
    queue = recordStageOutcome(queue, taskNumber, 'rebase-test', { status: 'success' })
    const consumed = consumeTaskWorkflowResult(queue, result as TaskWorkflowEnvelope)
    assert.equal(consumed.kind, 'queue')
    if (consumed.kind !== 'queue') return assert.fail('expected queue result')
    const report = buildMergeReport(consumed.queue)
    assert.match(report.unmerged[0]!.lastFailure, /record is missing; refusing to guess/)
    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.equal(archived.some((t: { taskNumber: number }) => t.taskNumber === taskNumber), false)
  } finally {
    removeFixture(root, worktreePath)
  }
})

test('rebase-test blocks on a real type error even when the complete suite passes', async () => {
  const taskNumber = 9025
  const tsc = join(REPO_ROOT, 'node_modules', '.bin', 'tsc')
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber, {
    testScript: `node -e "require('fs').writeFileSync('suite-ran.txt','yes')"`,
  })
  seedTaskFiles(root, taskNumber)
  seedWorktreeTaskFile(worktreePath, taskNumber)
  try {
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ['api.ts', 'use.ts'],
    }))
    writeFileSync(join(root, 'api.ts'), 'export const value: string = "ok"\n')
    writeFileSync(join(root, 'use.ts'), 'import { value } from "./api"\nconst expected: string = value\n')
    git(root, 'add', 'tsconfig.json', 'api.ts', 'use.ts')
    git(root, 'commit', '-q', '-m', 'add passing typed base')

    writeFileSync(join(worktreePath, 'task-only.txt'), 'task change\n')
    git(worktreePath, 'add', 'task-only.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    // Source moves incompatibly. Rebase is clean, npm test would pass, but tsc must fail.
    writeFileSync(join(root, 'api.ts'), 'export const value: number = 1\n')
    git(root, 'commit', '-am', 'incompatible source API')
    const sourceHead = git(root, 'rev-parse', 'main')

    const result = await runMergeStage(worktreePath, {
      task: taskNumber, stage: 'rebase-test', repositoryManifest, sourceRoot: root,
      typecheckCommand: `${JSON.stringify(tsc)} --noEmit`, maxRebaseFixRounds: 0,
    })

    let queue = createMergeQueue()
    queue = enqueueApprovedTask(queue, taskNumber)
    const consumed = consumeTaskWorkflowResult(queue, result as TaskWorkflowEnvelope)
    assert.equal(consumed.kind, 'queue')
    if (consumed.kind !== 'queue') return assert.fail('expected queue result')
    const report = buildMergeReport(consumed.queue)
    assert.equal(report.unmerged.length, 1)
    assert.match(report.unmerged[0]!.lastFailure, /typecheck/i)

    assert.equal(existsSync(join(worktreePath, 'suite-ran.txt')), false)
    assert.equal(git(root, 'rev-parse', 'main'), sourceHead)
    const rebasedTaskHead = git(worktreePath, 'rev-parse', 'HEAD')
    assert.throws(() => git(root, 'merge-base', '--is-ancestor', rebasedTaskHead, 'main'))
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

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const outcome = result.results[0] as { status: string, lastFailure: string }
    assert.equal(outcome.status, 'blocked')
    assert.match(outcome.lastFailure, /cleanup failed/)

    let queue = createMergeQueue()
    queue = enqueueApprovedTask(queue, taskNumber)
    queue = recordStageOutcome(queue, taskNumber, 'rebase-test', { status: 'success' })
    const consumed = consumeTaskWorkflowResult(queue, result as TaskWorkflowEnvelope)
    assert.equal(consumed.kind, 'queue')
    if (consumed.kind !== 'queue') return assert.fail('expected queue result')
    const report = buildMergeReport(consumed.queue)
    assert.equal(report.unmerged.length, 1)
    assert.equal(report.unmerged[0]!.taskNumber, taskNumber)
    assert.match(report.unmerged[0]!.lastFailure, /cleanup failed/)

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
    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })

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

// A root with a real test script and one submodule occurrence, both testable so a full merge+close can succeed.
const makeRootWithSubmoduleWorktree = (taskNumber: number) => {
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
  addTestScript(root, 'true')

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
      { occurrenceId: '', checkoutPath: root, parentOccurrenceId: null, pathInParent: null, gitlinkOid: null, depth: 0, originUrl: '', baseBranch: sourceBranch, baseOid, operationBranch, childOccurrenceIds: ['vendor'], testState: 'untested' },
      { occurrenceId: 'vendor', checkoutPath: submoduleCheckoutPath, parentOccurrenceId: '', pathInParent: 'vendor', gitlinkOid: null, depth: 1, originUrl: '', baseBranch: sourceBranch, baseOid: submoduleBaseOid, operationBranch, childOccurrenceIds: [], testState: 'untested' },
    ],
  }

  return { root, worktreePath, submoduleSource, submoduleCheckoutPath, operationBranch, repositoryManifest }
}

const commitVendorChange = (worktreePath: string) => {
  writeFileSync(join(worktreePath, 'vendor', 'vendor-new.txt'), 'vendor change\n')
  git(join(worktreePath, 'vendor'), 'add', 'vendor-new.txt')
  git(join(worktreePath, 'vendor'), 'commit', '-q', '-m', 'vendor change')
  git(worktreePath, 'add', 'vendor')
  git(worktreePath, 'commit', '-q', '-m', 'point at vendor task commit')
}

test('successful close deletes task-N from root and every source submodule', async () => {
  const taskNumber = 9023
  const { root, worktreePath, submoduleSource, submoduleCheckoutPath, operationBranch, repositoryManifest } = makeRootWithSubmoduleWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    commitVendorChange(worktreePath)

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const outcome = result.results[0] as { status: string, closed: number[] }
    assert.equal(outcome.status, 'merged')
    assert.deepEqual(outcome.closed, [taskNumber])
    assert.equal(existsSync(worktreePath), false)
    for (const sourcePath of [root, submoduleCheckoutPath]) {
      assert.throws(() => git(sourcePath, 'show-ref', '--verify', `refs/heads/${operationBranch}`))
      assert.throws(() => git(sourcePath, 'rev-parse', '--verify', `refs/taskTools/merged-commits/${operationBranch}`))
      assert.throws(() => git(sourcePath, 'rev-parse', '--verify', `refs/taskTools/merge-intents/${operationBranch}`))
    }
  } finally {
    removeFixture(root, worktreePath)
    rmSync(submoduleSource, { recursive: true, force: true })
  }
})

test('close failure retains root and every source-submodule task ref', async () => {
  const taskNumber = 9024
  const { root, worktreePath, submoduleSource, submoduleCheckoutPath, operationBranch, repositoryManifest } = makeRootWithSubmoduleWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  rmSync(join(root, '.taskTools', 'completedTasks.json'))
  mkdirSync(join(root, '.taskTools', 'completedTasks.json'))
  try {
    commitVendorChange(worktreePath)

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const outcome = result.results[0] as { status: string }
    assert.equal(outcome.status, 'merged-but-not-closed')
    assert.equal(existsSync(worktreePath), true)
    for (const sourcePath of [root, submoduleCheckoutPath]) {
      assert.doesNotThrow(() => git(sourcePath, 'show-ref', '--verify', `refs/heads/${operationBranch}`))
      assert.doesNotThrow(() => git(sourcePath, 'rev-parse', '--verify', `refs/taskTools/merged-commits/${operationBranch}`))
    }
  } finally {
    removeFixture(root, worktreePath)
    rmSync(submoduleSource, { recursive: true, force: true })
  }
})

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
  const worktreePath = createWorktreeForGroup(root, { groupId: taskNumber, taskNumbers: [taskNumber], filePaths: [], scope: 'declared' })
  symlinkSync(join(REPO_ROOT, 'scripts'), join(worktreePath, 'scripts'))
  mkdirSync(join(worktreePath, 'plans'), { recursive: true })
  // Real production manifest; its empty operationBranch forces task.workflow.js to supply the branch.
  const repositoryManifest = loadRepositoryManifest(root)
  assert.equal(repositoryManifest.occurrences[0].operationBranch, '')
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'plans', `task-${taskNumber}-plan.md`), 'plan\n')
    writeFileSync(join(worktreePath, 'plans', `brief-${taskNumber}.md`), 'brief\n')
    git(worktreePath, 'add', `plans/task-${taskNumber}-plan.md`, `plans/brief-${taskNumber}.md`)
    git(worktreePath, 'commit', '-q', '-m', 'plan and brief')

    const cwdBefore = process.cwd()
    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    assert.equal(process.cwd(), cwdBefore)

    const merged = result.results[0] as { status: string, closed: number[] }
    assert.equal(merged.status, 'merged')
    assert.deepEqual(merged.closed, [taskNumber])
    assert.equal(existsSync(worktreePath), false)
  } finally {
    removeFixture(root, worktreePath)
  }
})

test('attachOperationBranch sets the given branch on every occurrence, independent of any other invocation', () => {
  const occurrences = [
    { occurrenceId: '', checkoutPath: '/root', parentOccurrenceId: null, pathInParent: null, gitlinkOid: null, depth: 0, originUrl: '', baseBranch: 'main', baseOid: 'x', operationBranch: 'stale', childOccurrenceIds: ['vendor'], testState: 'untested' as const },
    { occurrenceId: 'vendor', checkoutPath: '/root/vendor', parentOccurrenceId: '', pathInParent: 'vendor', gitlinkOid: null, depth: 1, originUrl: '', baseBranch: 'main', baseOid: 'y', operationBranch: 'stale', childOccurrenceIds: [], testState: 'untested' as const },
  ]
  const forTask111 = attachOperationBranch(occurrences, 'task-111')
  const forTask222 = attachOperationBranch(occurrences, 'task-222')
  assert.deepEqual(forTask111.map((o) => o.operationBranch), ['task-111', 'task-111'])
  assert.deepEqual(forTask222.map((o) => o.operationBranch), ['task-222', 'task-222'])
  // Same occurrences, different results: proves branch comes from each call's own argument.
  assert.notDeepEqual(forTask111, forTask222)
})
