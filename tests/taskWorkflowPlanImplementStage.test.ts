import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { compileFunction, constants as vmConstants } from 'node:vm'
import { buildWorkflowArguments } from '../scripts/prepareTasks.ts'
import type { TaskRecord } from '../scripts/taskFiles.ts'

const REPO_ROOT = process.cwd()
const WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT, 'skills/tackle-tasks/task.workflow.js'), 'utf8')
  .replace('export const meta', 'const meta')

type AgentImpl = (prompt: string, options: { label: string }) => Promise<unknown>

type WorkflowEnvelope = {
  task: number
  stage: string
  results: Array<Record<string, unknown>>
}

// filename is the real script path; imports resolve against args.worktree, not cwd or a relocated filename.
const runTaskWorkflowAtRealScriptPath = async (
  args: Record<string, unknown>,
  agentImpl: AgentImpl,
): Promise<WorkflowEnvelope> => {
  const fn = compileFunction(
    `return (async () => { 'use strict'\n${WORKFLOW_SOURCE} })()`,
    ['args', 'log', 'agent'],
    { filename: join(REPO_ROOT, 'skills/tackle-tasks/task.workflow.js'), importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
  ) as (argsJson: string, log: (...values: unknown[]) => void, agent: AgentImpl) => Promise<WorkflowEnvelope>
  return await fn(JSON.stringify(args), () => {}, agentImpl)
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

const makeTwoTaskSourceRepo = (): { root: string; tasks: TaskRecord[] } => {
  const root = mkdtempSync(join(tmpdir(), 'task-workflow-plan-implement-root-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  mkdirSync(join(root, 'plans'), { recursive: true })
  writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'b.ts'), 'export const b = 1\n')
  writeFileSync(join(root, 'README.md'), 'root\n')
  git(root, 'add', 'a.ts', 'b.ts', 'README.md')
  git(root, 'commit', '-q', '-m', 'init')

  const tasks: TaskRecord[] = [
    { taskNumber: 1, title: 'task one', files: ['a.ts'], blockedBy: [] },
    { taskNumber: 2, title: 'task two', files: ['b.ts'], blockedBy: [] },
  ]
  mkdirSync(join(root, '.taskTools'), { recursive: true })
  writeFileSync(join(root, '.taskTools', 'tasks.json'), JSON.stringify(tasks))
  writeFileSync(join(root, '.taskTools', 'completedTasks.json'), '[]')
  git(root, 'add', '.taskTools')
  git(root, 'commit', '-q', '-m', 'seed task state')

  return { root, tasks }
}

// A real task worktree already has scripts/; these throwaway fixture repos don't.
const linkScripts = (worktree: string) => symlinkSync(join(REPO_ROOT, 'scripts'), join(worktree, 'scripts'))

const ownedFileFor = (taskNumber: number) => (taskNumber === 1 ? 'a.ts' : 'b.ts')

// A well-behaved planner+implementer: absolute paths only, commits via `git -C`.
const agentThatUsesOnlyAbsolutePathsAndCommitsWithGitC = (worktree: string): AgentImpl => async (_prompt, options) => {
  if (options.label.startsWith('plan:')) {
    const taskNumber = Number(options.label.slice('plan:'.length))
    const planFile = join(worktree, 'plans', `task-${taskNumber}-plan.md`)
    mkdirSync(dirname(planFile), { recursive: true })
    writeFileSync(planFile, `# plan for task ${taskNumber}\n\nEdit ${ownedFileFor(taskNumber)}.\n`)
    return { task: taskNumber, status: 'planned', planFile, question: '', missingFiles: [] }
  }
  if (options.label.startsWith('verify:')) {
    const taskNumber = Number(options.label.slice('verify:'.length))
    return { task: taskNumber, verdict: 'approved', notes: '', reviewer: 'claude', missingFiles: [] }
  }
  if (options.label.startsWith('implement:')) {
    const taskNumber = Number(options.label.slice('implement:'.length))
    const ownedFile = ownedFileFor(taskNumber)
    writeFileSync(join(worktree, ownedFile), `export const value = ${taskNumber}\n`)
    const notesRelative = `plans/task-${taskNumber}-implementation-notes.md`
    const notesFile = join(worktree, notesRelative)
    writeFileSync(notesFile, 'implementation notes\n')
    execFileSync('git', ['-C', worktree, 'add', '--', ownedFile, notesRelative])
    execFileSync('git', ['-C', worktree, 'commit', '-m', `task ${taskNumber}: implement`])
    return { task: taskNumber, status: 'done', summary: 'implemented the plan', remaining: [], notesFile }
  }
  throw new Error(`unexpected agent label: ${options.label}`)
}

const commitMessagesFor = (checkoutPath: string) => git(checkoutPath, 'log', '--format=%s').split('\n')

test('plan+implement commits only in each prepared task worktree', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const prepared = buildWorkflowArguments(root, 'true', tasks)
  const cwd = process.cwd()
  try {
    for (const group of prepared.groups) linkScripts(group.worktree)
    const sourceHead = git(root, 'rev-parse', 'HEAD')
    const sourceStatus = git(root, 'status', '--porcelain')

    const results = await Promise.all(prepared.groups.map(async (group) => {
      const task = group.tasks[0]!
      const scriptedAgent = agentThatUsesOnlyAbsolutePathsAndCommitsWithGitC(group.worktree)
      return runTaskWorkflowAtRealScriptPath({
        task: task.number,
        stage: 'plan+implement',
        typecheckCommand: prepared.typecheckCommand,
        worktree: group.worktree,
        sourceRoot: root,
      }, scriptedAgent)
    }))

    for (const result of results) {
      assert.equal(result.results[1]!.status, 'done')
    }

    assert.equal(process.cwd(), cwd)
    assert.equal(git(root, 'rev-parse', 'HEAD'), sourceHead)
    assert.equal(git(root, 'status', '--porcelain'), sourceStatus)

    const [groupA, groupB] = prepared.groups
    assert.ok(commitMessagesFor(groupA!.worktree).includes('task 1: implement'))
    assert.ok(!commitMessagesFor(groupA!.worktree).some((m) => m.startsWith('task 2:')))
    assert.ok(commitMessagesFor(groupB!.worktree).includes('task 2: implement'))
    assert.ok(!commitMessagesFor(groupB!.worktree).some((m) => m.startsWith('task 1:')))
  } finally {
    for (const group of prepared.groups) rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan+implement reports blocked when the implementer claims done without committing', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const task = tasks[0]!
  const prepared = buildWorkflowArguments(root, 'true', [task])
  try {
    const group = prepared.groups[0]!
    linkScripts(group.worktree)

    const dishonestAgent: AgentImpl = async (_prompt, options) => {
      if (options.label.startsWith('plan:')) {
        const planFile = join(group.worktree, 'plans', `task-${task.taskNumber}-plan.md`)
        mkdirSync(dirname(planFile), { recursive: true })
        writeFileSync(planFile, 'plan\n')
        return { task: task.taskNumber, status: 'planned', planFile, question: '', missingFiles: [] }
      }
      if (options.label.startsWith('verify:')) {
        return { task: task.taskNumber, verdict: 'approved', notes: '', reviewer: 'claude', missingFiles: [] }
      }
      if (options.label.startsWith('implement:')) {
        return {
          task: task.taskNumber,
          status: 'done',
          summary: 'implemented the plan',
          remaining: [],
          notesFile: join(group.worktree, 'plans', `task-${task.taskNumber}-implementation-notes.md`),
        }
      }
      throw new Error(`unexpected agent label: ${options.label}`)
    }

    const envelope = await runTaskWorkflowAtRealScriptPath({
      task: task.taskNumber,
      stage: 'plan+implement',
      typecheckCommand: prepared.typecheckCommand,
      worktree: group.worktree,
      sourceRoot: root,
    }, dishonestAgent)

    assert.equal(envelope.results[1]!.status, 'blocked')
  } finally {
    for (const group of prepared.groups) rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

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

test('plan+implement rejects missing sourceRoot before source or worktree mutation', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const task = tasks[0]!
  const prepared = buildWorkflowArguments(root, 'true', [task])
  const group = prepared.groups[0]!
  linkScripts(group.worktree)

  try {
    const sourceHead = git(root, 'rev-parse', 'HEAD')
    const sourceStatus = git(root, 'status', '--porcelain')
    const worktreeHead = git(group.worktree, 'rev-parse', 'HEAD')
    const worktreeStatus = git(group.worktree, 'status', '--porcelain')
    let agentRan = false

    await assert.rejects(
      runTaskWorkflowAtRealScriptPath({
        task: task.taskNumber,
        stage: 'plan+implement',
        typecheckCommand: prepared.typecheckCommand,
        worktree: group.worktree,
        // sourceRoot intentionally omitted
      }, async () => {
        agentRan = true
        throw new Error('agent must not run')
      }),
      /no "sourceRoot" in args/,
    )

    assert.equal(agentRan, false)
    assert.equal(git(root, 'rev-parse', 'HEAD'), sourceHead)
    assert.equal(git(root, 'status', '--porcelain'), sourceStatus)
    assert.equal(git(group.worktree, 'rev-parse', 'HEAD'), worktreeHead)
    assert.equal(git(group.worktree, 'status', '--porcelain'), worktreeStatus)
  } finally {
    rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})
