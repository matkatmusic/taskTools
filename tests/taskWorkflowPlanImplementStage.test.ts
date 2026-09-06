import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { compileFunction } from 'node:vm'
import { buildWorkflowArguments } from '../scripts/shared/prepareTasks.ts'
import type { TaskRecord } from '../scripts/shared/taskFiles.ts'

const REPO_ROOT = process.cwd()
const WORKFLOW_SOURCE = readFileSync(join(REPO_ROOT, 'skills/tackle-tasks-v1_1/tackle-tasks.workflow.js'), 'utf8')
  .replace('export const meta', 'const meta')
const EMITTER_PATH = join(REPO_ROOT, 'scripts/tackle-tasks/shared/tackle-tasks_AgentPromptEmitter.ts')

type AgentImpl = (prompt: string, options: { label: string; phase?: string }) => Promise<unknown>

type WorkflowEnvelope = {
  task: number
  stage: string
  results: Array<Record<string, unknown>>
}

// Real script path; args.worktree resolves imports. Defaults a root-only manifest, matching a real launch.
const runTaskWorkflowAtRealScriptPath = async (
  args: Record<string, unknown>,
  agentImpl: AgentImpl,
): Promise<WorkflowEnvelope> => {
  const fn = compileFunction(
    `return (async () => { 'use strict'\n${WORKFLOW_SOURCE} })()`,
    ['args', 'log', 'agent'],
    { filename: join(REPO_ROOT, 'skills/tackle-tasks-v1_1/tackle-tasks.workflow.js') },
  ) as (argsJson: string, log: (...values: unknown[]) => void, agent: AgentImpl) => Promise<WorkflowEnvelope>
  const repositoryManifest = {
    occurrences: [{ occurrenceId: '', checkoutPath: args.worktree, parentOccurrenceId: null, pathInParent: null, depth: 0 }],
  }
  return await fn(JSON.stringify({ agentPromptEmitterPath: EMITTER_PATH, repositoryManifest, ...args }), () => {}, agentImpl)
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

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

// C86-40: implement/plan+implement must fail loud, never silently claim root-only submodule support.
const runRawWorkflow = (argsJson: string, agentImpl: AgentImpl) => {
  const fn = compileFunction(
    `return (async () => { 'use strict'\n${WORKFLOW_SOURCE} })()`,
    ['args', 'log', 'agent'],
    { filename: join(REPO_ROOT, 'skills/tackle-tasks-v1_1/tackle-tasks.workflow.js') },
  ) as (argsJson: string, log: (...values: unknown[]) => void, agent: AgentImpl) => Promise<WorkflowEnvelope>
  return fn(argsJson, () => {}, agentImpl)
}

const throwingAgentForManifestGuard: AgentImpl = async () => { throw new Error('must not reach an agent call') }

for (const stage of ['implement', 'plan+implement']) {
  test(`${stage} refuses to run without a repositoryManifest instead of silently falling back to root-only`, async () => {
    await assert.rejects(
      () => runRawWorkflow(
        JSON.stringify({ task: 1, stage, worktree: '/tmp/tackle-tasks-manifest-guard-does-not-exist', sourceRoot: '/tmp/tackle-tasks-manifest-guard-does-not-exist', agentPromptEmitterPath: EMITTER_PATH }),
        throwingAgentForManifestGuard,
      ),
      /no "repositoryManifest" in args for stage "plan\+implement|implement"/,
    )
  })
}

test('plan alone tolerates a missing repositoryManifest', async () => {
  await assert.rejects(
    () => runRawWorkflow(
      JSON.stringify({ task: 1, stage: 'plan', worktree: '/tmp/tackle-tasks-manifest-guard-does-not-exist', sourceRoot: '/tmp/tackle-tasks-manifest-guard-does-not-exist', agentPromptEmitterPath: EMITTER_PATH }),
      throwingAgentForManifestGuard,
    ),
    (error: Error) => !/repositoryManifest/.test(error.message),
  )
})

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
      }, agentThatRunsRealEmitterAndScriptsJudgment(scriptedAgent))
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
    }, agentThatRunsRealEmitterAndScriptsJudgment(dishonestAgent))

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
    }, agentThatRunsRealEmitterAndScriptsJudgment(async (_prompt, options) => {
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
    }))

    assert.equal(envelope.results.length, 1)
    assert.equal(envelope.results[0]!.status, 'needs-clarification')
    assert.equal(verifierOrWorkerRan, false)
    assert.equal(existsSync(join(group.worktree, 'plans', `task-${task.taskNumber}-plan.md`)), false)
  } finally {
    rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan+implement rejects a planner that reports planned at the expected path without writing it', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const task = tasks[0]!
  const prepared = buildWorkflowArguments(root, 'true', [task])
  const group = prepared.groups[0]!
  linkScripts(group.worktree)

  try {
    const expectedPlanFile = join(group.worktree, 'plans', `task-${task.taskNumber}-plan.md`)
    let verifierOrWorkerRan = false

    const envelope = await runTaskWorkflowAtRealScriptPath({
      task: task.taskNumber,
      stage: 'plan+implement',
      typecheckCommand: prepared.typecheckCommand,
      worktree: group.worktree,
      sourceRoot: root,
    }, agentThatRunsRealEmitterAndScriptsJudgment(async (_prompt, options) => {
      if (options.label.startsWith('plan:')) {
        return {
          task: task.taskNumber,
          status: 'planned',
          planFile: expectedPlanFile,
          question: '',
          missingFiles: [],
        }
      }
      verifierOrWorkerRan = true
      throw new Error(`unexpected ${options.label}`)
    }))

    assert.equal(envelope.results.length, 1)
    assert.equal(envelope.results[0]!.status, 'needs-clarification')
    assert.equal(verifierOrWorkerRan, false)
    assert.equal(existsSync(expectedPlanFile), false)
  } finally {
    rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan, verify, widen-files, and apply-feedback calls all use the task-numbered Plan phase', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const task = tasks[0]!
  const prepared = buildWorkflowArguments(root, 'true', [task])
  const group = prepared.groups[0]!
  linkScripts(group.worktree)
  const seenPhases: Record<string, string | undefined> = {}
  let verifyCalls = 0

  try {
    const scriptedAgent: AgentImpl = async (_prompt, options) => {
      if (options.label.startsWith('plan:')) {
        seenPhases[`plan#${Object.keys(seenPhases).filter((k) => k.startsWith('plan#')).length}`] = options.phase
        const planFile = join(group.worktree, 'plans', `task-${task.taskNumber}-plan.md`)
        mkdirSync(dirname(planFile), { recursive: true })
        writeFileSync(planFile, 'plan\n')
        return { task: task.taskNumber, status: 'planned', planFile, question: '', missingFiles: [] }
      }
      if (options.label.startsWith('verify:')) {
        seenPhases[`verify#${verifyCalls}`] = options.phase
        verifyCalls += 1
        if (verifyCalls === 1) return { task: task.taskNumber, verdict: 'rejected', notes: '', reviewer: 'claude', missingFiles: ['c.ts'] }
        if (verifyCalls === 2) return { task: task.taskNumber, verdict: 'rejected', notes: 'fix it', reviewer: 'claude', missingFiles: [] }
        return { task: task.taskNumber, verdict: 'approved', notes: '', reviewer: 'claude', missingFiles: [] }
      }
      if (options.label.startsWith('applyFeedback:')) {
        seenPhases['applyFeedback'] = options.phase
        return {}
      }
      throw new Error(`unexpected agent label: ${options.label}`)
    }

    // widen-files is a driver role resolved by the real emitter, so capture its phase here instead.
    const innerAgent = agentThatRunsRealEmitterAndScriptsJudgment(scriptedAgent)
    const agentWithWidenFilesPhaseCapture: AgentImpl = async (prompt, options) => {
      if (options.label.startsWith('widen-files:')) seenPhases['widen-files'] = options.phase
      return innerAgent(prompt, options)
    }

    await runTaskWorkflowAtRealScriptPath({
      task: task.taskNumber,
      stage: 'plan',
      typecheckCommand: prepared.typecheckCommand,
      worktree: group.worktree,
      sourceRoot: root,
    }, agentWithWidenFilesPhaseCapture)

    const expectedPhase = `${task.taskNumber} Plan`
    assert.deepEqual(Object.keys(seenPhases).sort(), ['applyFeedback', 'plan#0', 'plan#1', 'verify#0', 'verify#1', 'verify#2', 'widen-files'])
    for (const [label, phase] of Object.entries(seenPhases)) assert.equal(phase, expectedPhase, `label ${label} used phase ${phase}`)
  } finally {
    rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan+implement blocks a notes-only commit that never touches an owned file', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const task = tasks[0]!
  const prepared = buildWorkflowArguments(root, 'true', [task])
  const group = prepared.groups[0]!
  linkScripts(group.worktree)

  try {
    const notesOnlyAgent: AgentImpl = async (_prompt, options) => {
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
        const notesRelative = `plans/task-${task.taskNumber}-implementation-notes.md`
        const notesFile = join(group.worktree, notesRelative)
        writeFileSync(notesFile, 'implementation notes\n')
        execFileSync('git', ['-C', group.worktree, 'add', '--', notesRelative])
        execFileSync('git', ['-C', group.worktree, 'commit', '-m', `task ${task.taskNumber}: notes only`])
        return { task: task.taskNumber, status: 'done', summary: 'implemented the plan', remaining: [], notesFile }
      }
      throw new Error(`unexpected agent label: ${options.label}`)
    }

    const envelope = await runTaskWorkflowAtRealScriptPath({
      task: task.taskNumber,
      stage: 'plan+implement',
      typecheckCommand: prepared.typecheckCommand,
      worktree: group.worktree,
      sourceRoot: root,
    }, agentThatRunsRealEmitterAndScriptsJudgment(notesOnlyAgent))

    assert.equal(envelope.results[1]!.status, 'blocked')
    assert.match((envelope.results[1] as any).summary, /committed no task-owned implementation path/)
  } finally {
    rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan+implement blocks a done result that deletes the previously committed notes file', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const task = tasks[0]!
  const prepared = buildWorkflowArguments(root, 'true', [task])
  const group = prepared.groups[0]!
  linkScripts(group.worktree)

  try {
    const notesRelative = `plans/task-${task.taskNumber}-implementation-notes.md`
    const notesAbsolute = join(group.worktree, notesRelative)
    mkdirSync(dirname(notesAbsolute), { recursive: true })
    writeFileSync(notesAbsolute, 'stale notes from a previous attempt\n')
    execFileSync('git', ['-C', group.worktree, 'add', '--', notesRelative])
    execFileSync('git', ['-C', group.worktree, 'commit', '-m', 'seed stale notes'])

    const deletesNotesAgent: AgentImpl = async (_prompt, options) => {
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
        writeFileSync(join(group.worktree, 'a.ts'), 'export const value = 42\n')
        execFileSync('git', ['-C', group.worktree, 'add', '--', 'a.ts'])
        execFileSync('git', ['-C', group.worktree, 'rm', '--', notesRelative])
        execFileSync('git', ['-C', group.worktree, 'commit', '-m', `task ${task.taskNumber}: implement and delete notes`])
        return { task: task.taskNumber, status: 'done', summary: 'implemented the plan', remaining: [], notesFile: notesAbsolute }
      }
      throw new Error(`unexpected agent label: ${options.label}`)
    }

    const envelope = await runTaskWorkflowAtRealScriptPath({
      task: task.taskNumber,
      stage: 'plan+implement',
      typecheckCommand: prepared.typecheckCommand,
      worktree: group.worktree,
      sourceRoot: root,
    }, agentThatRunsRealEmitterAndScriptsJudgment(deletesNotesAgent))

    assert.equal(envelope.results[1]!.status, 'blocked')
    assert.match((envelope.results[1] as any).summary, /missing the required notes file/)
  } finally {
    rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan+implement blocks an owned commit that omits the required notes file', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const task = tasks[0]!
  const prepared = buildWorkflowArguments(root, 'true', [task])
  const group = prepared.groups[0]!
  linkScripts(group.worktree)

  try {
    const ownedNoNotesAgent: AgentImpl = async (_prompt, options) => {
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
        writeFileSync(join(group.worktree, 'a.ts'), 'export const value = 99\n')
        execFileSync('git', ['-C', group.worktree, 'add', '--', 'a.ts'])
        execFileSync('git', ['-C', group.worktree, 'commit', '-m', `task ${task.taskNumber}: no notes`])
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
    }, agentThatRunsRealEmitterAndScriptsJudgment(ownedNoNotesAgent))

    assert.equal(envelope.results[1]!.status, 'blocked')
    assert.match((envelope.results[1] as any).summary, /missing the required notes file/)
  } finally {
    rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('widened ownership survives replanning, verification, and a separately launched implement stage', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const task = tasks[0]! // owns only a.ts; b.ts exists on disk but is unowned
  const prepared = buildWorkflowArguments(root, 'true', [task])
  const group = prepared.groups[0]!
  linkScripts(group.worktree)

  try {
    const planPrompts: string[] = []
    let verifyCalls = 0
    const planAndVerifyAgent: AgentImpl = async (prompt, options) => {
      if (options.label.startsWith('plan:')) {
        planPrompts.push(prompt as string)
        const planFile = join(group.worktree, 'plans', `task-${task.taskNumber}-plan.md`)
        mkdirSync(dirname(planFile), { recursive: true })
        writeFileSync(planFile, 'plan\n')
        return { task: task.taskNumber, status: 'planned', planFile, question: '', missingFiles: [] }
      }
      if (options.label.startsWith('verify:')) {
        verifyCalls += 1
        if (verifyCalls === 1) return { task: task.taskNumber, verdict: 'rejected', notes: '', reviewer: 'claude', missingFiles: ['b.ts'] }
        return { task: task.taskNumber, verdict: 'approved', notes: '', reviewer: 'claude', missingFiles: [] }
      }
      throw new Error(`unexpected agent label: ${options.label}`)
    }

    const planEnvelope = await runTaskWorkflowAtRealScriptPath({
      task: task.taskNumber,
      stage: 'plan',
      typecheckCommand: prepared.typecheckCommand,
      worktree: group.worktree,
      sourceRoot: root,
    }, agentThatRunsRealEmitterAndScriptsJudgment(planAndVerifyAgent))

    assert.equal(planEnvelope.results[0]!.status, 'planned')
    assert.equal(planPrompts.length, 2)
    assert.doesNotMatch(planPrompts[0]!, /b\.ts/)
    assert.match(planPrompts[1]!, /b\.ts/)

    const implementAgent: AgentImpl = async (_prompt, options) => {
      if (options.label.startsWith('implement:')) {
        return {
          task: task.taskNumber,
          status: 'blocked',
          summary: 'stub, only checking ownership',
          remaining: [],
          notesFile: join(group.worktree, 'plans', `task-${task.taskNumber}-implementation-notes.md`),
        }
      }
      throw new Error(`unexpected agent label: ${options.label}`)
    }

    const implementEnvelope = await runTaskWorkflowAtRealScriptPath({
      task: task.taskNumber,
      stage: 'implement',
      typecheckCommand: prepared.typecheckCommand,
      worktree: group.worktree,
      sourceRoot: root,
    }, agentThatRunsRealEmitterAndScriptsJudgment(implementAgent))

    assert.deepEqual((implementEnvelope.results[0] as any).files, ['a.ts', 'b.ts'])
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

// C86-22: the third round's widening must reach every downstream boundary, not just tasks.json and the plan.
test('a third rejected review with missingFiles widens every downstream implementation boundary', async () => {
  const { root, tasks } = makeTwoTaskSourceRepo()
  const task = tasks[0]!
  const origin = mkdtempSync(join(tmpdir(), 'task-workflow-plan-implement-origin-'))
  git(origin, 'init', '-q', '--bare')
  git(root, 'remote', 'add', 'origin', origin)

  const prepared = JSON.parse(
    execFileSync('node', [join(REPO_ROOT, 'scripts', 'shared', 'prepareTasks.ts'), String(task.taskNumber)], { cwd: root, encoding: 'utf8' }),
  )
  const group = prepared.groups.find((g: { tasks: { number: number }[] }) => g.tasks[0]?.number === task.taskNumber)
  linkScripts(group.worktree)
  let verifyCalls = 0
  let planCalls = 0
  let capturedImplementBrief = ''

  try {
    const scriptedAgent: AgentImpl = async (prompt, options) => {
      if (options.label.startsWith('plan:')) {
        planCalls += 1
        const planFile = join(group.worktree, 'plans', `task-${task.taskNumber}-plan.md`)
        mkdirSync(dirname(planFile), { recursive: true })
        writeFileSync(planFile, planCalls === 1 ? 'plan v1\n' : 'plan v2, now edits b.ts\n')
        return { task: task.taskNumber, status: 'planned', planFile, question: '', missingFiles: [] }
      }
      if (options.label.startsWith('verify:')) {
        verifyCalls += 1
        if (verifyCalls === 1) return { task: task.taskNumber, verdict: 'rejected', notes: 'fix 1', reviewer: 'claude', missingFiles: [] }
        if (verifyCalls === 2) return { task: task.taskNumber, verdict: 'rejected', notes: 'fix 2', reviewer: 'claude', missingFiles: [] }
        return { task: task.taskNumber, verdict: 'rejected', notes: 'needs b.ts', reviewer: 'claude', missingFiles: ['b.ts'] }
      }
      if (options.label.startsWith('applyFeedback:')) return {}
      if (options.label.startsWith('implement:')) {
        // Run the real emitter command itself, exactly as a live agent would, to capture the actual worker brief text.
        const match = prompt.match(EMITTER_COMMAND_RE)
        if (!match) throw new Error(`implement prompt has no embedded emitter command: ${prompt.slice(0, 200)}`)
        const [, emitterPath, taskArg, role, payloadJson] = match
        capturedImplementBrief = execFileSync('node', [emitterPath!, taskArg!, role!], { input: payloadJson, encoding: 'utf8' })

        writeFileSync(join(group.worktree, 'b.ts'), 'export const b = 2\n')
        const notesRelative = `plans/task-${task.taskNumber}-implementation-notes.md`
        writeFileSync(join(group.worktree, notesRelative), 'implementation notes\n')
        git(group.worktree, 'add', '--', 'b.ts', notesRelative)
        git(group.worktree, 'commit', '-q', '-m', `task ${task.taskNumber}: implement`)
        return { task: task.taskNumber, status: 'done', summary: 'implemented the plan', remaining: [], notesFile: join(group.worktree, notesRelative) }
      }
      throw new Error(`unexpected agent label: ${options.label}`)
    }

    const envelope = await runTaskWorkflowAtRealScriptPath({
      task: task.taskNumber,
      stage: 'plan+implement',
      typecheckCommand: prepared.typecheckCommand,
      worktree: group.worktree,
      sourceRoot: root,
      runId: prepared.runId,
    }, agentThatRunsRealEmitterAndScriptsJudgment(scriptedAgent))

    assert.equal(verifyCalls, 3)
    assert.equal(planCalls, 2)
    const planResult = envelope.results[0]!
    assert.equal(planResult.status, 'planned')
    assert.equal(planResult.reviewRounds, 0)
    assert.deepEqual(planResult.verify, { task: task.taskNumber, verdict: 'rejected', notes: 'needs b.ts', reviewer: 'claude', missingFiles: ['b.ts'] })
    assert.deepEqual(planResult.files, ['a.ts', 'b.ts'])

    const implementResult = envelope.results[1] as { status: string; fenceViolations: string[] }
    assert.equal(implementResult.status, 'done')
    assert.deepEqual(implementResult.fenceViolations, [])

    const authoritativeTasks = JSON.parse(readFileSync(join(root, '.taskTools', 'tasks.json'), 'utf8')) as TaskRecord[]
    assert.deepEqual(authoritativeTasks.find((t) => t.taskNumber === task.taskNumber)!.files, ['a.ts', 'b.ts'])
    assert.equal(readFileSync(planResult.planFile as string, 'utf8'), 'plan v2, now edits b.ts\n')

    const runArguments = JSON.parse(readFileSync(join(root, '.taskTools', 'run-arguments.json'), 'utf8'))
    const runArgumentsTask = runArguments.groups.flatMap((g: { tasks: { number: number; files: string[] }[] }) => g.tasks)
      .find((t: { number: number }) => t.number === task.taskNumber)
    assert.deepEqual(runArgumentsTask.files, ['a.ts', 'b.ts'])
    assert.match(readFileSync(join(group.worktree, 'plans', `brief-${task.taskNumber}.md`), 'utf8'), /b\.ts/)
    assert.match(capturedImplementBrief, /b\.ts/)
  } finally {
    rmSync(group.worktree, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    rmSync(origin, { recursive: true, force: true })
  }
})
