import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { compileFunction } from 'node:vm'
import { REPOSITORY_MANIFEST_VERSION, type RepositoryManifest } from '../scripts/repositoryManifest.ts'
import { attachOperationBranch, createWorktreeForGroup, loadRepositoryManifest, taskWorktreeLeasePath } from '../scripts/prepareTasks.ts'
import {
  beginNextLap, buildMergeReport, consumeCleanupRetryResult, consumeTaskWorkflowResult, createMergeQueue,
  enqueueApprovedTask, nextQueueStep, recordStageOutcome, shouldEndQueue, type CleanupRetryEnvelope, type TaskWorkflowEnvelope,
} from '../scripts/runMergePhase.ts'

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
const seedTaskFiles = (root: string, taskNumber: number, files: string[] = []) => {
  mkdirSync(join(root, '.taskTools'), { recursive: true })
  writeFileSync(join(root, '.taskTools', 'tasks.json'), JSON.stringify([{ taskNumber, title: 'fixture', files, blockedBy: [] }]))
  writeFileSync(join(root, '.taskTools', 'completedTasks.json'), '[]')
}

// A real task worktree already has its own checked-out .taskTools/tasks.json; loadPreparedTask reads it from cwd.
const seedWorktreeTaskFile = (worktreePath: string, taskNumber: number, files: string[] = []) => {
  mkdirSync(join(worktreePath, '.taskTools'), { recursive: true })
  writeFileSync(join(worktreePath, '.taskTools', 'tasks.json'), JSON.stringify([{ taskNumber, title: 'fixture', files, blockedBy: [] }]))
}

// A real worktree tracks these; commit the fixture's untracked stand-ins so they don't read as touched.
const commitWorktreeFixtureArtifacts = (worktreePath: string) => {
  git(worktreePath, 'add', '-A')
  git(worktreePath, 'commit', '-q', '-m', 'fixture: track test-only worktree artifacts')
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

// C86-36: an agent host that loses a structured result after the underlying command already completed.
const agentThatDropsTheFirstResultForRole = (targetRole: string): AgentImpl => {
  let seenForRole = 0
  return async (prompt) => {
    const match = prompt.match(EMITTER_COMMAND_RE)
    if (!match) throw new Error(`prompt has no embedded emitter command: ${prompt.slice(0, 200)}`)
    const [, emitterPath, taskArg, role, payloadJson] = match
    const output = execFileSync('node', [emitterPath!, taskArg!, role!], { input: payloadJson, encoding: 'utf8' })
    if (role === targetRole) {
      seenForRole += 1
      if (seenForRole === 1) return null
    }
    if (!output.startsWith(DRIVER_RESULT_PREFIX)) throw new Error(`unexpected non-driver output for role ${role}`)
    return JSON.parse(output.slice(DRIVER_RESULT_PREFIX.length).trim())
  }
}

const runWorkflowWithRawAgent = async (worktreePath: string, args: Record<string, unknown>, rawAgent: AgentImpl) => {
  const fn = compileFunction(
    `return (async () => { 'use strict'\n${WORKFLOW_SOURCE} })()`,
    ['args', 'log', 'agent'],
    { filename: join(REPO_ROOT, 'skills/tackle-tasks/tackle-tasks.workflow.js') },
  ) as WorkflowRunner
  return await fn(JSON.stringify({ worktree: worktreePath, agentPromptEmitterPath: EMITTER_PATH, ...args }), () => {}, rawAgent)
}

test('a lost merge result after full success recovers the original merged and closed receipt instead of re-merging', async () => {
  const taskNumber = 9041
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    const rawAgent = agentThatDropsTheFirstResultForRole('merge')
    const result = await runWorkflowWithRawAgent(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root }, rawAgent)

    const merged = result.results[0] as { status: string, mergedCommitHash: string, closed: number[] }
    assert.equal(merged.status, 'merged')
    assert.deepEqual(merged.closed, [taskNumber])
    assert.equal(existsSync(worktreePath), false)

    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(archived.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.equal(merged.mergedCommitHash, archived[0].commitHashes[0])
  } finally {
    removeFixture(root, worktreePath)
  }
})

test('a lost advance-conflict result after the rebase already continued is reconciled without a second continue or abort', async () => {
  const taskNumber = 9042
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  seedWorktreeTaskFile(worktreePath, taskNumber)
  commitWorktreeFixtureArtifacts(worktreePath)
  try {
    writeFileSync(join(worktreePath, 'README.md'), 'task change\n')
    git(worktreePath, 'add', 'README.md')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    writeFileSync(join(root, 'README.md'), 'main change\n')
    git(root, 'add', 'README.md')
    git(root, 'commit', '-q', '-m', 'main change')

    const rawAgent = agentThatDropsTheFirstResultForRole('advance-conflict')
    const resolveConflictAgent: AgentImpl = async (prompt, options) => {
      if (options.label.startsWith('rebase-conflict:')) {
        writeFileSync(join(worktreePath, 'README.md'), 'resolved change\n')
        return { resolved: true, summary: 'kept both changes' }
      }
      return rawAgent(prompt, options)
    }

    const result = await runWorkflowWithRawAgent(worktreePath, { task: taskNumber, stage: 'rebase-test', repositoryManifest, sourceRoot: root }, resolveConflictAgent)

    const outcome = result.results[0] as { status: string, fenceViolations: unknown[] }
    assert.equal(outcome.status, 'green')
    assert.deepEqual(outcome.fenceViolations, [])
    assert.doesNotThrow(() => git(worktreePath, 'show', 'HEAD:README.md'))
    assert.equal(git(worktreePath, 'show', 'HEAD:README.md'), 'resolved change')
  } finally {
    removeFixture(root, worktreePath)
  }
})

// C86-27/C86-36: a lost result must not silently drop the active occurrence's own fence violations.
test('a lost advance-conflict result recovers an extra active-occurrence touched path and still requires a re-gate', async () => {
  const taskNumber = 9048
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  seedWorktreeTaskFile(worktreePath, taskNumber)
  commitWorktreeFixtureArtifacts(worktreePath)
  try {
    writeFileSync(join(worktreePath, 'README.md'), 'task change\n')
    git(worktreePath, 'add', 'README.md')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    writeFileSync(join(root, 'README.md'), 'main change\n')
    git(root, 'add', 'README.md')
    git(root, 'commit', '-q', '-m', 'main change')

    const rawAgent = agentThatDropsTheFirstResultForRole('advance-conflict')
    // Resolving the conflict also requires fixing a call site in a sibling file — a real fence violation.
    const resolveConflictAndTouchSiblingAgent: AgentImpl = async (prompt, options) => {
      if (options.label.startsWith('rebase-conflict:')) {
        writeFileSync(join(worktreePath, 'README.md'), 'resolved change\n')
        writeFileSync(join(worktreePath, 'sibling.ts'), 'export const fixed = true\n')
        return { resolved: true, summary: 'kept both changes and fixed a call site' }
      }
      return rawAgent(prompt, options)
    }

    const envelope = await runWorkflowWithRawAgent(worktreePath, { task: taskNumber, stage: 'rebase-test', repositoryManifest, sourceRoot: root }, resolveConflictAndTouchSiblingAgent)

    const outcome = envelope.results[0] as { status: string, fenceViolations: { occurrenceId: string, path: string }[] }
    assert.equal(outcome.status, 'green')
    assert.deepEqual(outcome.fenceViolations, [{ occurrenceId: '', path: 'sibling.ts' }])
    assert.equal(git(worktreePath, 'show', 'HEAD:sibling.ts'), 'export const fixed = true')

    const consumed = consumeTaskWorkflowResult(createMergeQueue(), envelope as TaskWorkflowEnvelope)
    assert.equal(consumed.kind, 'requires-regate')
    if (consumed.kind !== 'requires-regate') return assert.fail('expected requires-regate result')
    assert.equal(consumed.approval.taskNumber, taskNumber)
    assert.deepEqual(consumed.approval.fenceViolations, [{ occurrenceId: '', path: 'sibling.ts' }])
    assert.deepEqual(consumed.queue.postApprovalViolations, [
      { taskNumber, fenceViolations: [{ occurrenceId: '', path: 'sibling.ts' }] },
    ])
  } finally {
    removeFixture(root, worktreePath)
  }
})

// C86-36: an earlier conflict's receipt must never surface in a later conflict on the same checkout.
test('advance-conflict receipts from an earlier conflict never appear in status, violations, or history of a later one', async () => {
  const taskNumber = 9050
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  seedWorktreeTaskFile(worktreePath, taskNumber)
  commitWorktreeFixtureArtifacts(worktreePath)
  try {
    // Two independent conflicts, replayed one at a time by the same `git rebase main`.
    writeFileSync(join(worktreePath, 'README.md'), 'task change to readme\n')
    git(worktreePath, 'add', 'README.md')
    git(worktreePath, 'commit', '-q', '-m', 'task change to readme')

    writeFileSync(join(worktreePath, 'package.json'), JSON.stringify({ scripts: { test: 'task-test-command' } }))
    git(worktreePath, 'add', 'package.json')
    git(worktreePath, 'commit', '-q', '-m', 'task change to package.json')

    writeFileSync(join(root, 'README.md'), 'main change to readme\n')
    git(root, 'add', 'README.md')
    git(root, 'commit', '-q', '-m', 'main change to readme')

    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'main-test-command' } }))
    git(root, 'add', 'package.json')
    git(root, 'commit', '-q', '-m', 'main change to package.json')

    let conflictAgentCalls = 0
    const resolveEitherConflictAgent: AgentImpl = async (prompt, options) => {
      if (options.label.startsWith('rebase-conflict:')) {
        conflictAgentCalls += 1
        // The brief names only the paths actually conflicted on this round — never guess the other file.
        if (prompt.includes('README.md')) writeFileSync(join(worktreePath, 'README.md'), 'resolved readme\n')
        if (prompt.includes('package.json')) writeFileSync(join(worktreePath, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }))
        return { resolved: true, summary: 'resolved' }
      }
      throw new Error(`unexpected agent call: ${options.label}`)
    }

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'rebase-test', repositoryManifest, sourceRoot: root }, resolveEitherConflictAgent)

    const outcome = result.results[0] as { status: string, fenceViolations: unknown[] }
    assert.equal(outcome.status, 'green')
    assert.deepEqual(outcome.fenceViolations, [])
    assert.equal(conflictAgentCalls, 2)

    // The receipts directory must never enter the checkout at all: not as status, not staged, not committed.
    assert.equal(git(worktreePath, 'status', '--porcelain'), '')
    const historyPaths = git(worktreePath, 'log', '--name-only', '--format=').split('\n').filter(Boolean)
    assert.ok(!historyPaths.some((path) => path.includes('advance-conflict-receipt')))
    assert.equal(existsSync(join(worktreePath, '.taskTools', 'advance-conflict-receipts')), false)
    assert.equal(existsSync(`${worktreePath}.advance-conflict-receipts`), true)
  } finally {
    rmSync(`${worktreePath}.advance-conflict-receipts`, { recursive: true, force: true })
    removeFixture(root, worktreePath)
  }
})

// C86-36: a lost first advance-conflict result must recover its own receipt, not consume the next real conflict.
test('a lost first advance-conflict result recovers via receipt while a genuinely different second conflict still gets its own agent call', async () => {
  const taskNumber = 9051
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  seedWorktreeTaskFile(worktreePath, taskNumber)
  commitWorktreeFixtureArtifacts(worktreePath)
  try {
    // Two independent conflicts, replayed one at a time by the same `git rebase main`.
    writeFileSync(join(worktreePath, 'README.md'), 'task change to readme\n')
    git(worktreePath, 'add', 'README.md')
    git(worktreePath, 'commit', '-q', '-m', 'task change to readme')

    writeFileSync(join(worktreePath, 'package.json'), JSON.stringify({ scripts: { test: 'task-test-command' } }))
    git(worktreePath, 'add', 'package.json')
    git(worktreePath, 'commit', '-q', '-m', 'task change to package.json')

    writeFileSync(join(root, 'README.md'), 'main change to readme\n')
    git(root, 'add', 'README.md')
    git(root, 'commit', '-q', '-m', 'main change to readme')

    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'main-test-command' } }))
    git(root, 'add', 'package.json')
    git(root, 'commit', '-q', '-m', 'main change to package.json')

    let conflictAgentCalls = 0
    const dropFirstAdvanceConflictResult = agentThatDropsTheFirstResultForRole('advance-conflict')
    const rawAgent: AgentImpl = async (prompt, options) => {
      if (options.label.startsWith('rebase-conflict:')) {
        conflictAgentCalls += 1
        // The brief names only the paths actually conflicted on this round — never guess the other file.
        if (prompt.includes('README.md')) writeFileSync(join(worktreePath, 'README.md'), 'resolved readme\n')
        if (prompt.includes('package.json')) writeFileSync(join(worktreePath, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }))
        return { resolved: true, summary: 'resolved' }
      }
      return dropFirstAdvanceConflictResult(prompt, options)
    }

    const envelope = await runWorkflowWithRawAgent(worktreePath, { task: taskNumber, stage: 'rebase-test', repositoryManifest, sourceRoot: root }, rawAgent)

    const outcome = envelope.results[0] as { status: string, fenceViolations: unknown[] }
    assert.equal(outcome.status, 'green')
    assert.deepEqual(outcome.fenceViolations, [])
    // Exactly one resolution call per real conflict: the dropped first result must recover from its receipt, not re-invoke resolution.
    assert.equal(conflictAgentCalls, 2)
    assert.equal(git(worktreePath, 'status', '--porcelain'), '')
    const historyPaths = git(worktreePath, 'log', '--name-only', '--format=').split('\n').filter(Boolean)
    assert.ok(!historyPaths.some((path) => path.includes('advance-conflict-receipt')))
  } finally {
    rmSync(`${worktreePath}.advance-conflict-receipts`, { recursive: true, force: true })
    removeFixture(root, worktreePath)
  }
})

// C86-36: no rebase in progress can mean aborted, not completed — the two must not be conflated.
test('the advance-conflict role reports advanced false, not true, against a checkout whose rebase already aborted', () => {
  const taskNumber = 9045
  const { root, worktreePath } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  seedWorktreeTaskFile(worktreePath, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'README.md'), 'task change\n')
    git(worktreePath, 'add', 'README.md')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    writeFileSync(join(root, 'README.md'), 'main change\n')
    git(root, 'add', 'README.md')
    git(root, 'commit', '-q', '-m', 'main change')

    // Already aborted: HEAD equals ORIG_HEAD, the same state a failed-continue-then-abort leaves.
    try { git(worktreePath, 'rebase', 'main') } catch { /* expected: conflicted */ }
    git(worktreePath, 'rebase', '--abort')

    const payload = {
      worktree: worktreePath, sourceRoot: root, runId: 'test-run',
      occurrenceId: '', conflictedFilePaths: ['README.md'], resolved: true,
      beforeOids: {}, checkoutPaths: { '': worktreePath },
    }
    const output = execFileSync('node', [EMITTER_PATH, String(taskNumber), 'advance-conflict'], { input: JSON.stringify(payload), encoding: 'utf8' })
    assert.ok(output.startsWith(DRIVER_RESULT_PREFIX))
    const result = JSON.parse(output.slice(DRIVER_RESULT_PREFIX.length).trim())

    assert.equal(result.advanced, false)
    assert.match(result.lastFailure, /unresolved merge conflict in root/)
    assert.notEqual(result.cleanupFailure, null)
  } finally {
    removeFixture(root, worktreePath)
  }
})

// C86-36: losing a cleanup-incomplete result must not re-enter merge/close and misreport merged-but-not-closed.
test('a lost cleanup-incomplete merge result is retried as cleanup-only, never re-merged or re-closed', async () => {
  const taskNumber = 9046
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    git(root, 'worktree', 'lock', worktreePath)

    const rawAgent = agentThatDropsTheFirstResultForRole('merge')
    const result = await runWorkflowWithRawAgent(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root }, rawAgent)

    const outcome = result.results[0] as { status: string, mergedCommitHash?: string, closed?: number[], closeError?: string }
    assert.equal(outcome.status, 'cleanup-incomplete')
    assert.equal('closeError' in outcome, false)
    assert.equal(existsSync(worktreePath), true)

    const archived = JSON.parse(readFileSync(join(root, '.taskTools', 'completedTasks.json'), 'utf8'))
    assert.deepEqual(archived.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
    assert.equal(outcome.mergedCommitHash, archived[0].commitHashes[0])
  } finally {
    try { git(root, 'worktree', 'unlock', worktreePath) } catch { /* already gone */ }
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

// C86-28: a locked worktree with a submodule and a real lease proves retainedArtifacts matches actual state.
test('merge stage: a locked worktree fails final cleanup with a warning-only outcome after a successful close', async () => {
  const taskNumber = 9022
  const { root, worktreePath, submoduleSource, submoduleCheckoutPath, operationBranch: branch, repositoryManifest } = makeRootWithSubmoduleWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    commitVendorChange(worktreePath)

    const runId = 'locked-worktree-run'
    const leasePath = taskWorktreeLeasePath(worktreePath)
    writeFileSync(leasePath, JSON.stringify({ runId, pid: process.pid, createdAt: Date.now() }))

    git(root, 'worktree', 'lock', worktreePath)

    const mergedCommitRef = `refs/taskTools/merged-commits/${branch}`
    const mergeIntentRef = `refs/taskTools/merge-intents/${branch}`

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root, runId })
    const outcome = result.results[0] as { status: string, cleanupWarning?: string, retainedArtifacts?: string[], closed: number[] }
    assert.equal(outcome.status, 'cleanup-incomplete')
    assert.equal(typeof outcome.cleanupWarning, 'string')
    assert.notEqual(outcome.cleanupWarning!.length, 0)
    assert.equal('lastFailure' in outcome, false)
    assert.deepEqual(outcome.closed, [taskNumber])
    // Persistence is retained, not deleted, while final cleanup is still incomplete.
    assert.doesNotThrow(() => git(root, 'rev-parse', '--verify', mergedCommitRef))

    // Submodule branch deletes before the locked worktree-remove throws, so it must not be retained.
    assert.throws(() => git(submoduleCheckoutPath, 'show-ref', '--verify', `refs/heads/${branch}`))
    const refPresent = (repoRoot: string, refName: string) => {
      try { git(repoRoot, 'rev-parse', '--verify', refName); return true } catch { return false }
    }
    const expectedArtifacts = new Set<string>([worktreePath, leasePath])
    if (refPresent(root, `refs/heads/${branch}`)) expectedArtifacts.add(`refs/heads/${branch}`)
    if (refPresent(root, mergedCommitRef)) expectedArtifacts.add(mergedCommitRef)
    if (refPresent(root, mergeIntentRef)) expectedArtifacts.add(mergeIntentRef)
    if (refPresent(submoduleCheckoutPath, mergedCommitRef)) expectedArtifacts.add(`${submoduleCheckoutPath}:${mergedCommitRef}`)
    if (refPresent(submoduleCheckoutPath, mergeIntentRef)) expectedArtifacts.add(`${submoduleCheckoutPath}:${mergeIntentRef}`)
    assert.deepEqual(new Set(outcome.retainedArtifacts), expectedArtifacts)
    assert.ok(outcome.retainedArtifacts!.includes(leasePath))
    assert.ok(outcome.retainedArtifacts!.some((path) => path.includes('vendor')))

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
    assert.equal(report.cleanupIncomplete.length, 1)
    assert.equal(report.cleanupIncomplete[0]!.taskNumber, taskNumber)
    assert.notEqual(report.cleanupIncomplete[0]!.warning.length, 0)

    // Idempotent cleanup-only retry: unlock, invoke the production 'cleanup-only' role — never re-merge or re-close.
    git(root, 'worktree', 'unlock', worktreePath)
    const retryResult = await runMergeStage(worktreePath, { task: taskNumber, stage: 'cleanup-only', repositoryManifest, sourceRoot: root, runId })
    const retryOutcome = retryResult.results[0] as { status: string, cleanupWarning?: string }
    assert.equal(retryOutcome.status, 'cleaned')
    assert.equal('cleanupWarning' in retryOutcome, false)
    const cleanedQueue = consumeCleanupRetryResult(consumed.queue, retryResult as CleanupRetryEnvelope)
    assert.deepEqual(buildMergeReport(cleanedQueue).cleanupIncomplete, [])

    assert.equal(existsSync(worktreePath), false)
    assert.equal(existsSync(leasePath), false)
    for (const sourcePath of [root, submoduleCheckoutPath]) {
      assert.throws(() => git(sourcePath, 'show-ref', '--verify', `refs/heads/${branch}`))
      assert.throws(() => git(sourcePath, 'rev-parse', '--verify', mergedCommitRef))
      assert.throws(() => git(sourcePath, 'rev-parse', '--verify', mergeIntentRef))
    }
    // Idempotent: invoking the retry again on the already-clean state still reports success.
    const secondRetry = await runMergeStage(worktreePath, { task: taskNumber, stage: 'cleanup-only', repositoryManifest, sourceRoot: root, runId })
    assert.equal((secondRetry.results[0] as { status: string }).status, 'cleaned')
  } finally {
    try { git(root, 'worktree', 'unlock', worktreePath) } catch { /* already gone */ }
    removeFixture(root, worktreePath)
    rmSync(submoduleSource, { recursive: true, force: true })
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

// C86-41: an out-of-fence commit in the fix's own layer must surface as a violation, not slip through green.
test('rebase-fix: a root-layer fix that commits an unapproved file returns green but reports a fence violation and forces a re-gate', async () => {
  const taskNumber = 9048
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber, [])
  seedWorktreeTaskFile(worktreePath, taskNumber, [])
  commitWorktreeFixtureArtifacts(worktreePath)
  try {
    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    const outsideFencePath = join(worktreePath, 'outside-fence.txt')
    const fixAgent = async (...values: unknown[]) => {
      const options = values[1] as { label: string }
      if (options.label.startsWith('rebase-fix:')) {
        if (!existsSync(outsideFencePath)) {
          writeFileSync(outsideFencePath, 'not approved\n')
          git(worktreePath, 'add', 'outside-fence.txt')
          git(worktreePath, 'commit', '-q', '-m', 'add outside-fence.txt')
        }
        return { fixed: true, summary: 'added outside-fence.txt' }
      }
      throw new Error(`unexpected agent call: ${options.label}`)
    }

    const result = await runMergeStage(
      worktreePath,
      { task: taskNumber, stage: 'rebase-test', repositoryManifest, sourceRoot: root, typecheckCommand: `test -f ${JSON.stringify(outsideFencePath)}` },
      fixAgent,
    )
    const outcome = result.results[0] as { status: string, fenceViolations: Array<{ occurrenceId: string, path: string }> }
    assert.equal(outcome.status, 'green')
    assert.deepEqual(outcome.fenceViolations, [{ occurrenceId: '', path: 'outside-fence.txt' }])

    let queue = createMergeQueue()
    queue = enqueueApprovedTask(queue, taskNumber)
    const consumed = consumeTaskWorkflowResult(queue, result as TaskWorkflowEnvelope)
    assert.equal(consumed.kind, 'requires-regate')
  } finally {
    removeFixture(root, worktreePath)
  }
})

test('rebase-fix: a fix that only commits an already-approved path stays green without a false-positive fence violation', async () => {
  const taskNumber = 9050
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber, ['taskfile.txt', 'approved-fix.txt'])
  seedWorktreeTaskFile(worktreePath, taskNumber, ['taskfile.txt', 'approved-fix.txt'])
  commitWorktreeFixtureArtifacts(worktreePath)
  try {
    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    const approvedFixPath = join(worktreePath, 'approved-fix.txt')
    const fixAgent = async (...values: unknown[]) => {
      const options = values[1] as { label: string }
      if (options.label.startsWith('rebase-fix:')) {
        if (!existsSync(approvedFixPath)) {
          writeFileSync(approvedFixPath, 'approved\n')
          git(worktreePath, 'add', 'approved-fix.txt')
          git(worktreePath, 'commit', '-q', '-m', 'add approved-fix.txt')
        }
        return { fixed: true, summary: 'added approved-fix.txt' }
      }
      throw new Error(`unexpected agent call: ${options.label}`)
    }

    const result = await runMergeStage(
      worktreePath,
      { task: taskNumber, stage: 'rebase-test', repositoryManifest, sourceRoot: root, typecheckCommand: `test -f ${JSON.stringify(approvedFixPath)}` },
      fixAgent,
    )
    const outcome = result.results[0] as { status: string, fenceViolations: Array<{ occurrenceId: string, path: string }> }
    assert.equal(outcome.status, 'green')
    assert.deepEqual(outcome.fenceViolations, [])

    let queue = createMergeQueue()
    queue = enqueueApprovedTask(queue, taskNumber)
    const consumed = consumeTaskWorkflowResult(queue, result as TaskWorkflowEnvelope)
    assert.equal(consumed.kind, 'queue')
  } finally {
    removeFixture(root, worktreePath)
  }
})

// Isolates roleRebaseFixVerify: the full retry loop also flags a submodule HEAD advance as root-touched.
test('rebase-fix-verify: a nested submodule-layer commit outside the fence is normalized to a root-relative violation', () => {
  const taskNumber = 9049
  const { root, worktreePath, submoduleSource, repositoryManifest } = makeRootWithSubmoduleWorktree(taskNumber)
  seedTaskFiles(root, taskNumber, ['vendor/vendor-new.txt'])
  try {
    commitVendorChange(worktreePath)

    const vendorCheckoutPath = join(worktreePath, 'vendor')
    const activeBeforeOid = git(vendorCheckoutPath, 'rev-parse', 'HEAD')
    writeFileSync(join(vendorCheckoutPath, 'vendor-outside-fence.txt'), 'not approved\n')
    git(vendorCheckoutPath, 'add', 'vendor-outside-fence.txt')
    git(vendorCheckoutPath, 'commit', '-q', '-m', 'add vendor-outside-fence.txt')

    const payload = {
      worktree: worktreePath, sourceRoot: root,
      checkoutPath: vendorCheckoutPath, occurrenceId: 'vendor',
      beforeOids: {}, checkoutPaths: {}, activeBeforeOid, repositoryManifest,
    }
    const output = execFileSync('node', [EMITTER_PATH, String(taskNumber), 'rebase-fix-verify'], { input: JSON.stringify(payload), encoding: 'utf8' })
    assert.ok(output.startsWith(DRIVER_RESULT_PREFIX))
    const verify = JSON.parse(output.slice(DRIVER_RESULT_PREFIX.length).trim())
    assert.deepEqual(verify.touchedPaths, [])
    assert.deepEqual(verify.activeFenceViolations, [{ occurrenceId: 'vendor', path: 'vendor/vendor-outside-fence.txt' }])
  } finally {
    removeFixture(root, worktreePath)
    rmSync(submoduleSource, { recursive: true, force: true })
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

test('rebase-test stage: a rebase-walk driver returning no result blocks the lap instead of throwing', async () => {
  const taskNumber = 9044
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    const rawAgent: AgentImpl = async (prompt) => {
      const match = prompt.match(EMITTER_COMMAND_RE)
      if (!match) throw new Error(`prompt has no embedded emitter command: ${prompt.slice(0, 200)}`)
      const [, , , role] = match
      if (role === 'rebase-walk') return null
      throw new Error(`unexpected role reached: ${role}`)
    }

    const result = await runWorkflowWithRawAgent(worktreePath, { task: taskNumber, stage: 'rebase-test', repositoryManifest, sourceRoot: root }, rawAgent)
    const outcome = result.results[0] as { status: string, lastFailure: string }
    assert.equal(outcome.status, 'blocked')
    assert.equal(outcome.lastFailure, 'rebase-walk driver returned no result')
    assert.equal(existsSync(worktreePath), true)
  } finally {
    removeFixture(root, worktreePath)
  }
})

// C86-21: the driver itself normalizes an unexpected exception into a typed result, preserving completedLayers.
test('merge stage: an unexpected merge driver exception is normalized to a typed parent-conflicted result instead of throwing', async () => {
  const taskNumber = 9045
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    // A leaf ref here collides with the nested ref the driver writes next, so update-ref throws mid-merge.
    git(root, 'update-ref', 'refs/taskTools/merge-intents', git(root, 'rev-parse', 'HEAD'))

    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const outcome = result.results[0] as { status: string, lastFailure: string, completedLayers: unknown[] }
    assert.equal(outcome.status, 'parent-conflicted')
    assert.match(outcome.lastFailure, /merge-intents/)
    assert.deepEqual(outcome.completedLayers, [])
    assert.equal(existsSync(worktreePath), true)
    const stillOpen = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8'))
    assert.deepEqual(stillOpen.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
  } finally {
    removeFixture(root, worktreePath)
  }
})

// C86-21: a merge-record failure AFTER the root merge lands must report merged-but-not-closed, never a conflict.
test('merge stage: a merge-record failure after the root lands reports merged-but-not-closed, not a conflict', async () => {
  const taskNumber = 9046
  const { root, worktreePath, repositoryManifest } = makeRootWithWorktree(taskNumber)
  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'taskfile.txt'), 'task change\n')
    git(worktreePath, 'add', 'taskfile.txt')
    git(worktreePath, 'commit', '-q', '-m', 'task change')

    // A leaf ref here collides with the nested ref recordMergedCommit writes only after mergeGroup lands the root merge.
    git(root, 'update-ref', 'refs/taskTools/merged-commits', git(root, 'rev-parse', 'HEAD'))

    const beforeMain = git(root, 'rev-parse', 'main')
    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const outcome = result.results[0] as { status: string, mergedCommitHash: string, lastFailure: string, closeError: string }
    const afterMain = git(root, 'rev-parse', 'main')

    assert.notEqual(afterMain, beforeMain)
    assert.equal(outcome.status, 'merged-but-not-closed')
    assert.equal(outcome.mergedCommitHash, afterMain)
    assert.match(outcome.lastFailure, /merged-commits/)
    assert.match(outcome.closeError, /merged-commits/)
    assert.equal(existsSync(worktreePath), true)
    const stillOpen = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8'))
    assert.deepEqual(stillOpen.map((t: { taskNumber: number }) => t.taskNumber), [taskNumber])
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

    // C86-20: the child (submodule) merge that landed before the parent failed must count as lap progress.
    let queue = createMergeQueue()
    queue = enqueueApprovedTask(queue, taskNumber)
    queue = recordStageOutcome(queue, taskNumber, 'rebase-test', { status: 'success' })
    const consumed = consumeTaskWorkflowResult(queue, result as TaskWorkflowEnvelope)
    assert.equal(consumed.kind, 'queue')
    if (consumed.kind !== 'queue') return assert.fail('expected queue result')
    assert.equal(consumed.queue.mergedThisLap, 0)
    assert.equal(consumed.queue.sourceProgressThisLap, true)
    assert.equal(shouldEndQueue(consumed.queue, false), 'continue')
    const nextLap = beginNextLap(consumed.queue)
    assert.equal(nextLap.sourceProgressThisLap, false)
    assert.deepEqual(nextQueueStep(nextLap), { taskNumber, stage: 'rebase-test' })
  } finally {
    removeFixture(root, worktreePath)
    rmSync(submoduleSource, { recursive: true, force: true })
  }
})

// C86-42: a submodule merge that lands but whose record write fails must still count as progress and be resumable.
test('merge stage: a submodule record-write failure after the submodule lands still counts as progress and resumes cleanly', async () => {
  const taskNumber = 9047
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
  // root itself gets no package.json test script, so its own layer stays untested after the submodule merges.

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

  seedTaskFiles(root, taskNumber)
  try {
    writeFileSync(join(worktreePath, 'vendor', 'vendor-new.txt'), 'vendor change\n')
    git(join(worktreePath, 'vendor'), 'add', 'vendor-new.txt')
    git(join(worktreePath, 'vendor'), 'commit', '-q', '-m', 'vendor change')
    git(worktreePath, 'add', 'vendor')
    git(worktreePath, 'commit', '-q', '-m', 'point at vendor task commit')

    // A leaf ref here collides with the nested ref recordMergedCommit writes only after the submodule merge lands.
    git(submoduleCheckoutPath, 'update-ref', 'refs/taskTools/merged-commits', git(submoduleCheckoutPath, 'rev-parse', sourceBranch))

    const submoduleHeadBefore = git(submoduleCheckoutPath, 'rev-parse', sourceBranch)
    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const outcome = result.results[0] as { status: string, failedAtStage: string, completedLayers: Array<{ occurrenceId: string, status: string }> }

    assert.notEqual(git(submoduleCheckoutPath, 'rev-parse', sourceBranch), submoduleHeadBefore)
    assert.equal(outcome.status, 'parent-conflicted')
    assert.equal(outcome.failedAtStage, 'test')
    assert.deepEqual(
      outcome.completedLayers.map((layer) => ({ occurrenceId: layer.occurrenceId, status: layer.status })),
      [{ occurrenceId: 'vendor', status: 'merged' }],
    )

    let queue = createMergeQueue()
    queue = enqueueApprovedTask(queue, taskNumber)
    queue = recordStageOutcome(queue, taskNumber, 'rebase-test', { status: 'success' })
    const consumed = consumeTaskWorkflowResult(queue, result as TaskWorkflowEnvelope)
    assert.equal(consumed.kind, 'queue')
    if (consumed.kind !== 'queue') return assert.fail('expected queue result')
    assert.equal(consumed.queue.sourceProgressThisLap, true)
    assert.equal(shouldEndQueue(consumed.queue, false), 'continue')

    // A retry lap must recognize the already-landed submodule and resume, not report merge-record-missing.
    const retryResult = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root })
    const retryOutcome = retryResult.results[0] as { status: string, completedLayers: Array<{ occurrenceId: string, status: string }> }
    assert.notEqual(retryOutcome.status, 'merge-record-missing')
    assert.deepEqual(
      retryOutcome.completedLayers.map((layer) => ({ occurrenceId: layer.occurrenceId, status: layer.status })),
      [{ occurrenceId: 'vendor', status: 'no-op' }],
    )
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
  const runId = 'production-shaped-run'
  const worktreePath = createWorktreeForGroup(root, { groupId: taskNumber, taskNumbers: [taskNumber], filePaths: [], scope: 'declared' }, runId)
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
    const result = await runMergeStage(worktreePath, { task: taskNumber, stage: 'merge', repositoryManifest, sourceRoot: root, runId })
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
