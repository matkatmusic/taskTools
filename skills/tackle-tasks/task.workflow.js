const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const N = ARGS.task
const STAGE = ARGS.stage ?? 'plan+implement'
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
// Unlike TYPECHECK_COMMAND (brief-text display default), an unconfigured rebase-test must skip typecheck, not silently run one.
const REBASE_TYPECHECK_COMMAND = ARGS.typecheckCommand ?? null
const WORKER_MODEL = ARGS.workerModel
const MAX_FIX_ROUNDS = ARGS.maxRounds ?? 3
const MAX_REBASE_FIX_ROUNDS = ARGS.maxRebaseFixRounds ?? 3
const WORKTREE = ARGS.worktree
if (!WORKTREE) throw new Error('task.workflow.js: no "worktree" in args; every stage must run inside the prepared task worktree')
const SOURCE_ROOT = ARGS.sourceRoot
if (!SOURCE_ROOT) throw new Error('task.workflow.js: no "sourceRoot" in args')

export const meta = {
  name: `task-${N}`,
  description: 'Run one task through its stage pipeline (plan / implement / rebase-test / merge)',
  phases: [
    { title: `${N} Plan`, detail: 'write and refine the task plan' },
    { title: `${N} Implement`, detail: 'implement the plan and check the file fence' },
    { title: `${N} Rebase-Test`, detail: 'rebase onto source and run the full suite' },
    { title: `${N} Merge`, detail: 'merge and close the task' },
  ],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    status: { type: 'string', enum: ['planned', 'needs-clarification', 'not-relevant'] },
    planFile: { type: 'string' },
    question: { type: 'string' },
    missingFiles: { type: 'array', items: { type: 'string' } },
    files: { type: 'array', items: { type: 'string' } },
  },
  required: ['task', 'status', 'planFile', 'question'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    notes: { type: 'string' },
    reviewer: { type: 'string', enum: ['codex', 'claude'] },
    missingFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['task', 'verdict', 'notes', 'reviewer'],
}

const APPLY_FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    applied: { type: 'boolean' },
  },
  required: ['task', 'applied'],
}

const WORKER_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    remaining: { type: 'array', items: { type: 'string' } },
    notesFile: { type: 'string' },
  },
  required: ['task', 'status', 'summary', 'remaining', 'notesFile'],
}

const MERGE_CONFLICT_SCHEMA = {
  type: 'object',
  properties: {
    resolved: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['resolved', 'summary'],
}

const REBASE_FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['fixed', 'summary'],
}

const fileRetryPreamble = (missingFiles) => `Before planning: the workflow has already widened this task's owned files in tasks.json to include ${missingFiles.join(', ')} and regenerated the brief file — you do not need to run any command for this. The owned-files list below already includes the paths you previously flagged as missing.

`

const testsInstruction = (t) => t.tests && t.tests !== 'skip'
  ? `The task's tests field holds an example test the user wrote — put it into the plan's verification section as the concrete check to run, expanded with a few extra cases covering the individual functions/subparts it touches: ${t.tests}`
  : 'This task has no tests field, or it is the literal string "skip" — do not require TDD; write ordinary verification commands in the plan instead.'

const worktreePath = (t, relativePath) => `${t.repoRoot.replace(/\/+$/, '')}/${relativePath}`

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`

const ownedPathMap = (t) => t.files
  .map((file) => `  - ${file} => ${worktreePath(t, file)}`)
  .join('\n')

const plannerBrief = (t, preamble = '') => `${preamble}Invoke /ponytail:ponytail ultra.
taskWorktree = ${t.repoRoot}
Read this brief file by its absolute path: ${t.briefFile}
Owned files (repo-relative => absolute in taskWorktree):
${ownedPathMap(t)}

For every filesystem tool call, use the absolute taskWorktree path shown above.
Never resolve a repo-relative task path against your ambient working directory,
and never read or edit the same relative path in another checkout.

Read the owned files — a plan that guesses at their contents will be rejected.
Follow ~/.claude/guides/planning.md and write the plan to exactly this absolute path: ${t.planFile}
Do not change any source file — this is planning only, not implementation.

The plan must be exact enough that the implementer makes no discovery of its own:
- Name every edit by file path and line number, with the current text and what it becomes.
- Account for every owned file: either its exact edit list, or the reason it needs no edit.
- Resolve every question while planning. Write no conditional instruction — no
  "re-check", no "verify before editing", no "if the live file disagrees", no
  "trust the live file". If you could not settle something, that is
  needs-clarification, not a fallback sentence in the plan.
- Quote only text you actually read. Never describe an excerpt the brief does not contain.
- State the verification that proves the change worked, as commands with expected results.
- ${testsInstruction(t)}

If the plan would need to edit a file outside the absolute owned paths above, set status
"needs-clarification" and name that file in "question" — do not plan the edit anyway.
If the blocker is instead that you need to READ a file outside the absolute owned paths
to write an exact plan, set status "needs-clarification", populate
missingFiles with the repo-relative path(s) of each file you need, and use
"question" to explain why each path is needed.
If the task is unclear, set status "needs-clarification" and put your
question in "question". If the task no longer applies to the codebase, set
status "not-relevant" and explain why in "question". Otherwise write the
plan file and set status "planned".
Return {task: ${t.number}, status, planFile: "${t.planFile}", question, missingFiles}.
You are forbidden to edit any file other than ${t.planFile}; to read a file outside
the absolute owned paths; to leave a decision for the implementer; or to write a plan step
whose exact target you did not read.`

const codexPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, replace the FIXES section with a "MISSING_FILES:" section instead: one repo-relative file path per line, the paths the plan would need read access to, and no other text in that section.`

const verifierBrief = (t, planFile) => {
  const prompt = JSON.stringify(codexPrompt(t, planFile))
  const command = `codex exec -s read-only ${prompt}`
  // ponytail: opus/high, not fable/medium — the fallback replaces the strictest gate in the pipeline
  const opusFallbackCommand = `claude -p ${prompt} --tools "Read" --model claude-opus-4-8 --effort high`
  const fableFallbackCommand = `claude -p ${prompt} --tools "Read" --model fable --effort medium`
  return `Review the plan for task #${t.number} by running exactly this command:

${command}

If that command exits with an error code, codex is unavailable — not a
verdict. Unavailability looks like a non-zero exit with no APPROVED or
REJECTED first line and no PROBLEMS or FIXES block: overloaded api, usage
exceeded, not logged in, rate limited, or no codex binary on PATH. In that
case run this command instead, and treat its output exactly as you would
codex's:

${fableFallbackCommand}
if that command also exits with an error code, run this command instead, and treat its output exactly as you would codex's:

${opusFallbackCommand}

Whichever reviewer answers prints its verdict on the first line. Never edit
any file — this agent only reviews the plan, it never applies fixes to it.
Never run any command other than the ones above.

Report which reviewer actually produced the verdict you return: reviewer
"codex" if the codex command answered, reviewer "claude" if you had to fall
back. Never report a fallback review as codex.

If the run prints APPROVED: return verdict "approved", missingFiles [], and
the reviewer's reasoning in notes.

If the run prints REJECTED: it also prints a PROBLEMS section, and either a
FIXES section or a MISSING_FILES section. Copy the PROBLEMS section and
whichever of FIXES or MISSING_FILES it printed into notes verbatim — that
text is the only thing anyone sees before deciding what to do about this
plan. If it printed a MISSING_FILES section, also copy each line of that
section into missingFiles as an array of repo-relative path strings.
Otherwise return missingFiles as an empty array.

Return {task: ${t.number}, verdict, notes, reviewer, missingFiles}.`
}

const applyFeedbackBrief = (t, planFile, notes) => `Apply reviewer feedback to a plan file. The reviewer's PROBLEMS and FIXES are below, verbatim:

${notes}

Read ${planFile}, then edit it so it satisfies every fix listed above. The only file you may ever edit is ${planFile} — never touch a source file, the brief, or any other file, and never run any command.

If the text above has no FIXES section to apply (for example a MISSING_FILES section instead), make no edits and return applied false.

Return {task: ${t.number}, applied: true} once you have made the edits, or {task: ${t.number}, applied: false} if there was nothing to apply.`

const tddInstruction = (t) => t.tests && t.tests !== 'skip'
  ? `This task's tests field holds an example test the user wrote: ${t.tests}\nWrite that test first, then expand it to also cover the individual functions/subparts you build, before writing the implementation.`
  : 'This task has no tests field, or it is the literal string "skip" — skip TDD entirely and just write the code.'

const workerBrief = (t, note) => {
  const rootedTypecheck = `(cd -- ${shellQuote(t.repoRoot)} && ${TYPECHECK_COMMAND})`
  const gitAddPaths = t.files.length
    ? [...t.files, t.notesFile].map(shellQuote).join(' ')
    : `${shellQuote(t.notesFile)} (plus every other path you edited, listed explicitly)`

  return `You are implementing EXACTLY ONE pre-planned task from
${worktreePath(t, '.taskTools/tasks.json')}: #${t.number}.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

taskWorktree = ${t.repoRoot}
ownedFiles = ${t.files.join(', ')}
ownedPaths (the only editable source/test paths) =
${ownedPathMap(t)}
plan = ${t.planFile}
notesFile = ${t.notesFile}
timeBudget = 10 minutes
${note ? `note = ${note}\n` : ''}
${tddInstruction(t)}

Treat taskWorktree as the project root for jot:implement. Every repo-relative
path in the plan means its absolute path under taskWorktree. Use absolute paths
for Read/Edit/Search. Never edit the corresponding path in the ambient checkout.

use jot:implement ${t.planFile}, writing its implementation-notes log to exactly notesFile

if the plan is impossible as written:
    return {task: ${t.number}, status: "blocked", summary: why it cannot be done, remaining: [], notesFile: notesFile}

implement every step of the plan, editing only ownedPaths

typecheck = run(${rootedTypecheck})
if typecheck reported errors in ownedPaths:
    fix them using their absolute taskWorktree paths

if ${worktreePath(t, 'scripts/relatedTests.ts')} exists:
    tests = run it from taskWorktree to discover the tests covering ownedFiles
else:
    tests = the absolute test paths under taskWorktree belonging to ownedFiles
// never run the full suite; that is the close-tasks gate, not yours

results = run every test command as (cd -- ${shellQuote(t.repoRoot)} && <test command>)
fixRound = 0
while any test failed and fixRound is less than ${MAX_FIX_ROUNDS}:
    fixRound = fixRound + 1
    fix the cause
    typecheck = run(${rootedTypecheck})
    results = run every test command as (cd -- ${shellQuote(t.repoRoot)} && <test command>)

if any test still failed after ${MAX_FIX_ROUNDS} fix rounds:
    return {task: ${t.number}, status: "blocked", summary: what is still failing after ${MAX_FIX_ROUNDS} fix rounds, remaining: the failing test names, notesFile: notesFile}

if typecheck is clean and every test passed:
    run: git -C ${shellQuote(t.repoRoot)} add -- ${gitAddPaths}
    run: git -C ${shellQuote(t.repoRoot)} commit -m ${shellQuote(`task ${t.number}: one-line summary`)}
    return {task: ${t.number}, status: "done", summary: one sentence, remaining: [], notesFile: notesFile}
else if part of the plan is implemented:
    return {task: ${t.number}, status: "partial", summary: one sentence, remaining: the plan steps not yet done, plus any failing test names, notesFile: notesFile}
else:
    return {task: ${t.number}, status: "blocked", summary: one sentence, remaining: the failing test names, notesFile: notesFile}

if you reach timeBudget before finishing:
    return status "partial" with the not-yet-done plan steps in remaining, notesFile still set to notesFile

You are forbidden to touch anything outside ownedPaths excluding notesFile; to
add scope or refactors the plan does not call for; to redecide anything the
plan already decided; to run the full suite, \`git add -A\`, or \`git add .\`; to
commit while anything fails; to attempt more than ${MAX_FIX_ROUNDS} fix
rounds; or to return status "done" with a failing test. Any test file created
or modified must be listed in ownedFiles; otherwise return status "blocked"
without editing it.

You are forbidden to use an ambient-cwd-relative filesystem path or a bare Git
command. Every Git command must use git -C taskWorktree, and every other shell
command must explicitly run inside taskWorktree.`
}

const mergeConflictBrief = (checkoutPath, conflictedFilePaths) => `A rebase in ${checkoutPath} is stopped on live conflict markers, not aborted. Resolve exactly these conflicted paths — this is the complete list, do not search the repository for more:
${conflictedFilePaths.map((p) => `  - ${p}`).join('\n')}

Carry out every step below, in order, from top to bottom.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

You may READ anything, anywhere in the tree — callers, callees, tests, other layers.
You may EDIT any file in any layer — resolving a conflict often means updating a call
site, and a call site can live in a different repository.

for each path in the list above:
    open ${checkoutPath}/path
    resolve every <<<<<<< / ======= / >>>>>>> block, keeping BOTH sides' intent
    remove the conflict markers
    run(git -C ${checkoutPath} add path)

if resolving a conflict required editing a file in a DIFFERENT repository than ${checkoutPath}:
    run(git add) and run(git commit) for that edit, in that repository's own checkout, before moving on
    // a rebase requires a clean tree; an uncommitted edit in a not-yet-rebased layer would break that layer's own rebase

Do not run \`git rebase --continue\` or \`git rebase --abort\` in ${checkoutPath} yourself — the caller drives that after you return.

if git -C ${checkoutPath} diff --name-only --diff-filter=U prints nothing (every listed path is resolved and staged):
    return {resolved: true, summary: what you changed}
else:
    return {resolved: false, summary: what is still unresolved and why}

You are forbidden to weaken, delete, or stub out code to make a conflict
disappear; to force-push or hard-reset anything you did not create; to run
\`git rebase --continue\` or \`git rebase --abort\` yourself; or to leave an edit
in a different repository uncommitted. Returning resolved false is a correct
outcome when a conflict genuinely cannot be resolved, not a failure.`

const rebaseFixBrief = (checkoutPath, occurrenceId, testOutput, forbiddenPaths) => `The test suite for layer "${occurrenceId === '' ? 'root' : occurrenceId}" is RED after a rebase, in ${checkoutPath}. Fix the cause.

Carry out every step below, in order, from top to bottom.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

Failure output from the test run:
${testOutput}

You may READ anything, anywhere in the tree. You may EDIT any file inside ${checkoutPath} — the failing test, or the code it covers. Do not edit any file outside ${checkoutPath}. These paths inside ${checkoutPath} are OTHER layers (separate occurrences) and are out of scope even though they sit on disk under ${checkoutPath} — do not edit anything inside them: ${forbiddenPaths.length === 0 ? '(none)' : forbiddenPaths.join(', ')}

fix the cause of the failure

run(git -C ${checkoutPath} add -A)
run(git -C ${checkoutPath} commit -m "task ${N}: fix rebase-test failure in ${occurrenceId === '' ? 'root' : occurrenceId}")
// rebase needs a clean tree; this commit is never undone — it survives for the next lap

if git -C ${checkoutPath} status --porcelain prints nothing (the fix is committed):
    return {fixed: true, summary: what you changed}
else:
    return {fixed: false, summary: why the tree is still dirty}

You are forbidden to weaken, delete, or stub out a test or the code it covers
to make the failure disappear; to edit any file outside ${checkoutPath}, or
inside a layer listed above as out of scope; to force-push or hard-reset
anything you did not create; or to leave your edit uncommitted.`

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

const MAX_REVIEW_ROUNDS = 3

let preparedTask = null

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
  return {
    number: N,
    briefFile,
    planFile: `${repoRoot}/plans/task-${N}-plan.md`,
    notesFile: `${repoRoot}/plans/task-${N}-implementation-notes.md`,
    files: Array.isArray(task.files) ? task.files : [],
    tests: task.tests,
    repoRoot,
    pair,
  }
}

// A planner that reports "planned" without writing the file at planFile never wrote a plan.
const rejectPlannedWithoutPlanFile = async (planResult) => {
  if (planResult.status !== 'planned') return planResult
  const { existsSync } = await import('node:fs')
  if (existsSync(planResult.planFile)) return planResult
  return {
    ...planResult,
    status: 'needs-clarification',
    question: 'planner reported status "planned" but did not write the plan file inside the task worktree',
  }
}

const runPlan = async () => {
  log(`task ${N}: plan stage`)
  preparedTask = await loadPreparedTask()
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { addTaskFiles } = await import(pathToFileURL(join(WORKTREE, 'scripts/addTaskFiles.ts')).href)
  const { writeTaskBriefFile } = await import(pathToFileURL(join(WORKTREE, 'scripts/prepareTasks.ts')).href)
  const result = await retryAgent(() => agent(plannerBrief(preparedTask), { label: `plan:${N}`, phase: 'Plan', schema: PLAN_SCHEMA }))
  let planResult = {
    stage: 'plan',
    ...(result ?? {
      task: N,
      status: 'needs-clarification',
      planFile: '',
      question: 'planner returned no result after 3 attempts',
    }),
  }
  planResult.files = preparedTask.files
  planResult = await rejectPlannedWithoutPlanFile(planResult)
  if (planResult.status !== 'planned') return planResult
  const runVerify = async () => await retryAgent(() => agent(verifierBrief(preparedTask, preparedTask.planFile), { label: `verify:${N}`, phase: 'Plan', schema: VERIFY_SCHEMA })) ?? {
    task: N,
    verdict: 'rejected',
    notes: 'verifier agent returned no result after 3 attempts (killed, errored, or blocked)',
    reviewer: 'none',
    missingFiles: [],
  }
  const widenFilesAndReplan = async (missingFiles) => {
    const widenedTasks = addTaskFiles([N], missingFiles, SOURCE_ROOT)
    const widenedTask = widenedTasks.find((entry) => entry.taskNumber === N)
    if (!widenedTask) throw new Error(`task.workflow.js: task ${N} disappeared from tasks.json`)
    writeTaskBriefFile(widenedTask, preparedTask.repoRoot)
    preparedTask.files = Array.isArray(widenedTask.files) ? widenedTask.files : []
    const rePlanned = await retryAgent(() => agent(plannerBrief(preparedTask, fileRetryPreamble(missingFiles)), { label: `plan:${N}`, phase: 'Plan', schema: PLAN_SCHEMA }))
    planResult = {
      stage: 'plan',
      ...(rePlanned ?? {
        task: N,
        status: 'needs-clarification',
        planFile: '',
        question: 'planner returned no result after 3 attempts',
      }),
    }
    planResult.files = preparedTask.files
    planResult = await rejectPlannedWithoutPlanFile(planResult)
  }
  let reviewRounds = MAX_REVIEW_ROUNDS
  let verify = await runVerify()
  reviewRounds -= 1
  while (verify.verdict !== 'approved' && reviewRounds > 0) {
    if (Array.isArray(verify.missingFiles) && verify.missingFiles.length > 0) {
      await widenFilesAndReplan(verify.missingFiles)
      if (planResult.status !== 'planned') return planResult
    } else {
      await retryAgent(() => agent(applyFeedbackBrief(preparedTask, preparedTask.planFile, verify.notes), { label: `applyFeedback:${N}`, phase: 'Plan', schema: APPLY_FEEDBACK_SCHEMA }))
    }
    verify = await runVerify()
    reviewRounds -= 1
  }
  return { ...planResult, verify, reviewRounds }
}

const runWorker = (t, note) => {
  const options = {
    label: `implement:${t.number}`,
    phase: `${t.number} Implement`,
    schema: WORKER_SCHEMA,
  }
  if (WORKER_MODEL) options.model = WORKER_MODEL
  return retryAgent(() => agent(workerBrief(t, note), options))
}

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

  const headAfter = execFileSync('git', ['-C', preparedTask.repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (result.status === 'done' && headAfter === base) {
    result = {
      ...result,
      status: 'blocked',
      summary: 'implementer reported done but made no commit in taskWorktree',
      remaining: ['commit the implementation in the prepared task worktree'],
    }
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

const readHeadOid = (execFileSync, checkoutPath) => execFileSync('git', ['-C', checkoutPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

const changedPathsSinceOid = (execFileSync, checkoutPath, beforeOid) => execFileSync('git', ['-C', checkoutPath, 'diff', '--name-only', `${beforeOid}..HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean)

// occurrenceId -> checkout path in THIS worktree, never the source manifest's checkoutPath.
const taskWorktreeCheckoutPaths = (occurrences, worktreePath, join) => {
  const byId = new Map(occurrences.map((o) => [o.occurrenceId, o]))
  const resolved = new Map()
  const resolve = (occurrenceId) => {
    if (resolved.has(occurrenceId)) return resolved.get(occurrenceId)
    const occurrence = byId.get(occurrenceId)
    const checkoutPath = occurrence.parentOccurrenceId === null
      ? worktreePath
      : join(resolve(occurrence.parentOccurrenceId), occurrence.pathInParent)
    resolved.set(occurrenceId, checkoutPath)
    return checkoutPath
  }
  for (const occurrence of occurrences) resolve(occurrence.occurrenceId)
  return resolved
}

const commitOccurrenceChanges = (execFileSync, checkoutPath, occurrenceId) => {
  try {
    execFileSync('git', ['-C', checkoutPath, 'add', '-A'], { stdio: 'ignore' })
    execFileSync('git', ['-C', checkoutPath, 'commit', '-q', '-m', `resolve merge conflict: cross-layer edit in ${occurrenceId === '' ? 'root' : occurrenceId}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const abortRebaseChecked = (execFileSync, checkoutPath) => {
  try {
    execFileSync('git', ['-C', checkoutPath, 'rebase', '--abort'], { stdio: 'ignore' })
    return { aborted: true, failureReason: null }
  } catch (error) {
    return { aborted: false, failureReason: String((error && error.message) || error) }
  }
}

// Editor disabled: a plain --continue must never block on an interactive prompt.
const continueRebaseChecked = (execFileSync, checkoutPath) => {
  try {
    execFileSync('git', ['-C', checkoutPath, 'rebase', '--continue'], { stdio: 'ignore', env: { ...process.env, GIT_EDITOR: 'true' } })
    return { continued: true, freshConflict: false, failureReason: null }
  } catch (error) {
    const stillConflicted = execFileSync('git', ['-C', checkoutPath, 'diff', '--name-only', '--diff-filter=U'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    // A later commit hit a fresh conflict: the next walk call reports it, not a failure.
    if (stillConflicted.length > 0) return { continued: false, freshConflict: true, failureReason: null }
    return { continued: false, freshConflict: false, failureReason: String((error && error.message) || error) }
  }
}

const runMergeConflictAgent = (checkoutPath, conflictedFilePaths) => retryAgent(() => agent(
  mergeConflictBrief(checkoutPath, conflictedFilePaths),
  { label: `rebase-conflict:${N}`, phase: `${N} Rebase-Test`, schema: MERGE_CONFLICT_SCHEMA },
))

const runRebaseFixAgent = (checkoutPath, occurrenceId, testOutput, forbiddenPaths) => retryAgent(() => agent(
  rebaseFixBrief(checkoutPath, occurrenceId, testOutput, forbiddenPaths),
  { label: `rebase-fix:${N}`, phase: `${N} Rebase-Test`, schema: REBASE_FIX_SCHEMA },
))

// Resolves one conflict, commits cross-layer edits deepest-first, drives continue/abort.
const advanceLiveConflict = async (execFileSync, uncommittedChangedFiles, occurrencesDeepestFirst, checkoutPaths, activeOccurrenceId, conflictedFilePaths, fenceViolations) => {
  const checkoutPath = checkoutPaths.get(activeOccurrenceId)
  const conflictSummary = `unresolved merge conflict in ${activeOccurrenceId || 'root'}; unresolved paths: ${conflictedFilePaths.join(', ')}`
  const otherOccurrences = occurrencesDeepestFirst.filter((o) => o.occurrenceId !== activeOccurrenceId)
  const beforeOids = otherOccurrences.map((o) => [o.occurrenceId, readHeadOid(execFileSync, checkoutPaths.get(o.occurrenceId))])

  const result = await runMergeConflictAgent(checkoutPath, conflictedFilePaths)
  if (result === null || result === undefined || result.resolved !== true) {
    const abortResult = abortRebaseChecked(execFileSync, checkoutPath)
    return { advanced: false, lastFailure: conflictSummary, cleanupFailure: abortResult.aborted ? null : `abort failed: ${abortResult.failureReason}` }
  }

  for (const path of uncommittedChangedFiles(checkoutPath)) {
    if (!conflictedFilePaths.includes(path)) fenceViolations.push({ occurrenceId: activeOccurrenceId, path })
    execFileSync('git', ['-C', checkoutPath, 'add', path], { stdio: 'ignore' })
  }

  for (const [occurrenceId, beforeOid] of beforeOids) {
    const otherPath = checkoutPaths.get(occurrenceId)
    const uncommitted = uncommittedChangedFiles(otherPath)
    for (const path of new Set([...changedPathsSinceOid(execFileSync, otherPath, beforeOid), ...uncommitted])) {
      fenceViolations.push({ occurrenceId, path })
    }
    if (uncommitted.length === 0) continue
    const committed = commitOccurrenceChanges(execFileSync, otherPath, occurrenceId)
    if (!committed || uncommittedChangedFiles(otherPath).length > 0) {
      const abortResult = abortRebaseChecked(execFileSync, checkoutPath)
      const reason = `commit failed for occurrence "${occurrenceId}"`
      return { advanced: false, lastFailure: conflictSummary, cleanupFailure: abortResult.aborted ? reason : `${reason}; abort failed: ${abortResult.failureReason}` }
    }
  }

  const continuation = continueRebaseChecked(execFileSync, checkoutPath)
  if (continuation.continued || continuation.freshConflict) return { advanced: true, lastFailure: null, cleanupFailure: null }
  const abortResult = abortRebaseChecked(execFileSync, checkoutPath)
  const reason = `continue failed: ${continuation.failureReason}`
  return { advanced: false, lastFailure: conflictSummary, cleanupFailure: abortResult.aborted ? reason : `${reason}; abort failed: ${abortResult.failureReason}` }
}

const runRebaseTest = async () => {
  log(`task ${N}: rebase-test stage`)
  if (!preparedTask) preparedTask = await loadPreparedTask()
  const { execFileSync } = await import('node:child_process')
  const { join, relative } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { rebaseSubmoduleLayersDeepestFirst, rebaseParentOntoSourceAndTest, uncommittedChangedFiles } = await import(pathToFileURL(join(WORKTREE, 'scripts/mergeTaskWorktrees.ts')).href)
  const { createEmptyResolutionManifest } = await import(pathToFileURL(join(WORKTREE, 'scripts/resolutionRequests.ts')).href)
  const { attachOperationBranch } = await import(pathToFileURL(join(WORKTREE, 'scripts/prepareTasks.ts')).href)
  const worktreePath = preparedTask.repoRoot
  const manifest = { repositoryManifest: { ...ARGS.repositoryManifest, occurrences: attachOperationBranch(ARGS.repositoryManifest.occurrences, `task-${N}`) }, resolutionManifest: createEmptyResolutionManifest() }
  const occurrences = manifest.repositoryManifest.occurrences
  const rootOccurrence = occurrences.find((o) => o.occurrenceId === '')
  const sourceBranch = rootOccurrence.baseBranch
  const submodulePaths = occurrences
    .filter((o) => o.parentOccurrenceId === '')
    .map((o) => o.pathInParent)
    .filter((p) => p !== null)
  const checkoutPaths = taskWorktreeCheckoutPaths(occurrences, worktreePath, join)
  const occurrencesDeepestFirst = [...occurrences].sort((a, b) => b.depth - a.depth)
  const fenceViolations = []
  const fixRoundsByOccurrenceId = new Map()
  const consumeFixRound = (occurrenceId) => {
    const used = (fixRoundsByOccurrenceId.get(occurrenceId) ?? 0) + 1
    fixRoundsByOccurrenceId.set(occurrenceId, used)
    return used
  }
  // A parent's checkoutPath contains every submodule's checkoutPath; exclude those nested layers explicitly.
  const descendantCheckoutPaths = (occurrenceId) => {
    const ownPath = checkoutPaths.get(occurrenceId)
    return occurrencesDeepestFirst
      .filter((o) => o.occurrenceId !== occurrenceId)
      .map((o) => checkoutPaths.get(o.occurrenceId))
      .filter((path) => {
        const rel = relative(ownPath, path)
        return rel !== '' && !rel.startsWith('..')
      })
  }
  // Verifies a fix attempt before any rebase/test cycle re-runs: unfixed, dirty, or another layer touched all fail.
  const attemptRebaseFix = async (occurrenceId, checkoutPath, testOutput) => {
    const otherOccurrences = occurrencesDeepestFirst.filter((o) => o.occurrenceId !== occurrenceId)
    const beforeOids = otherOccurrences.map((o) => [o.occurrenceId, readHeadOid(execFileSync, checkoutPaths.get(o.occurrenceId))])
    const fixOutcome = await runRebaseFixAgent(checkoutPath, occurrenceId, testOutput, descendantCheckoutPaths(occurrenceId))
    let otherLayerTouched = false
    for (const [otherId, beforeOid] of beforeOids) {
      const otherPath = checkoutPaths.get(otherId)
      const touchedPaths = new Set([...changedPathsSinceOid(execFileSync, otherPath, beforeOid), ...uncommittedChangedFiles(otherPath)])
      for (const path of touchedPaths) {
        fenceViolations.push({ occurrenceId: otherId, path })
        otherLayerTouched = true
      }
    }
    const ownCheckoutClean = uncommittedChangedFiles(checkoutPath).length === 0
    return fixOutcome != null && fixOutcome.fixed === true && ownCheckoutClean && !otherLayerTouched
  }

  let layerWalk = rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, true, REBASE_TYPECHECK_COMMAND)
  while (layerWalk.stoppedAt !== null && (layerWalk.stoppedAt.status === 'conflicted' || layerWalk.stoppedAt.status === 'tests-failed')) {
    const stopped = layerWalk.stoppedAt
    if (stopped.status === 'conflicted') {
      const { occurrenceId, conflictedFilePaths } = stopped
      const outcome = await advanceLiveConflict(execFileSync, uncommittedChangedFiles, occurrencesDeepestFirst, checkoutPaths, occurrenceId, conflictedFilePaths, fenceViolations)
      if (!outcome.advanced) {
        return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: outcome.lastFailure, cleanupFailure: outcome.cleanupFailure, occurrenceId, fenceViolations }
      }
    } else {
      const { occurrenceId, checkoutPath, testOutput } = stopped
      let fixSucceeded = false
      while (!fixSucceeded) {
        if (consumeFixRound(occurrenceId) > MAX_REBASE_FIX_ROUNDS) {
          return {
            stage: 'rebase-test', task: N, status: 'blocked',
            lastFailure: `${stopped.failedCheck} still red after MAX_REBASE_FIX_ROUNDS`,
            failedCheck: stopped.failedCheck,
            occurrenceId, fenceViolations,
          }
        }
        fixSucceeded = await attemptRebaseFix(occurrenceId, checkoutPath, testOutput)
      }
    }
    layerWalk = rebaseSubmoduleLayersDeepestFirst(worktreePath, manifest, true, REBASE_TYPECHECK_COMMAND)
  }
  if (layerWalk.stoppedAt !== null) {
    const stopped = layerWalk.stoppedAt
    const lastFailure = stopped.status === 'untested' ? 'untested layer' : stopped.status
    return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure, occurrenceId: stopped.occurrenceId, layerOutcome: stopped, fenceViolations }
  }

  let parentOutcome = rebaseParentOntoSourceAndTest('', worktreePath, sourceBranch, submodulePaths, manifest.resolutionManifest, true, REBASE_TYPECHECK_COMMAND)
  while (parentOutcome.status === 'conflicted' || parentOutcome.status === 'tests-failed') {
    if (parentOutcome.status === 'conflicted') {
      const outcome = await advanceLiveConflict(execFileSync, uncommittedChangedFiles, occurrencesDeepestFirst, checkoutPaths, '', parentOutcome.conflictedFilePaths, fenceViolations)
      if (!outcome.advanced) {
        return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure: outcome.lastFailure, cleanupFailure: outcome.cleanupFailure, occurrenceId: '', fenceViolations }
      }
    } else {
      let fixSucceeded = false
      while (!fixSucceeded) {
        if (consumeFixRound('') > MAX_REBASE_FIX_ROUNDS) {
          return {
            stage: 'rebase-test', task: N, status: 'blocked',
            lastFailure: `${parentOutcome.failedCheck} still red after MAX_REBASE_FIX_ROUNDS`,
            failedCheck: parentOutcome.failedCheck,
            occurrenceId: '', fenceViolations,
          }
        }
        fixSucceeded = await attemptRebaseFix('', worktreePath, parentOutcome.testOutput)
      }
    }
    parentOutcome = rebaseParentOntoSourceAndTest('', worktreePath, sourceBranch, submodulePaths, manifest.resolutionManifest, true, REBASE_TYPECHECK_COMMAND)
  }
  if (parentOutcome.status !== 'rebased-and-tested') {
    const lastFailure = parentOutcome.status === 'untested' ? 'untested layer' : parentOutcome.status
    return { stage: 'rebase-test', task: N, status: 'blocked', lastFailure, occurrenceId: '', parentOutcome, fenceViolations }
  }

  return { stage: 'rebase-test', task: N, status: 'green', fenceViolations }
}

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

const concreteMergeStageFailure = (report) => {
  const explicit = typeof report.failureReason === 'string' ? report.failureReason.trim() : ''
  if (explicit) return explicit

  const occurrence = report.status === 'parent-conflicted' ? 'root' : (report.occurrenceId || 'unknown layer')
  const conflictSuffix = Array.isArray(report.conflictedFilePaths) && report.conflictedFilePaths.length > 0
    ? `; unresolved paths: ${report.conflictedFilePaths.join(', ')}`
    : ''
  const kind = report.stage === 'merge' ? 'merge failure' : report.stage === 'rebase' ? 'rebase conflict' : 'test failure'
  return `${kind} in ${occurrence} (${report.status})${conflictSuffix}`
}

const runMerge = async () => {
  log(`task ${N}: merge stage`)
  const repoRoot = WORKTREE
  const { execFileSync } = await import('node:child_process')
  const { existsSync, unlinkSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { mergeTaskDeepestFirst, removeTaskWorktreeAndBranches, deleteTaskMergePersistence } = await import(pathToFileURL(join(repoRoot, 'scripts/mergeTaskWorktrees.ts')).href)
  const { createEmptyResolutionManifest } = await import(pathToFileURL(join(repoRoot, 'scripts/resolutionRequests.ts')).href)
  const { currentBranchName } = await import(pathToFileURL(join(repoRoot, 'scripts/repositoryBranches.ts')).href)
  const { closeTasks } = await import(pathToFileURL(join(repoRoot, 'scripts/closeTasks.ts')).href)
  const { attachOperationBranch } = await import(pathToFileURL(join(repoRoot, 'scripts/prepareTasks.ts')).href)
  try {
    cleanupPlanAndBriefFiles(execFileSync, existsSync, unlinkSync, join, repoRoot)
  } catch (error) {
    return { stage: 'merge', task: N, status: 'blocked', lastFailure: `cleanup failed: ${String((error && error.message) || error)}` }
  }
  const manifest = { repositoryManifest: { ...ARGS.repositoryManifest, occurrences: attachOperationBranch(ARGS.repositoryManifest.occurrences, `task-${N}`) }, resolutionManifest: createEmptyResolutionManifest() }
  // mergeTaskDeepestFirst rewrites occurrence.checkoutPath to the worktree; read the root before it runs.
  const rootOccurrence = manifest.repositoryManifest.occurrences.find((o) => o.occurrenceId === '')
  if (rootOccurrence.checkoutPath !== SOURCE_ROOT) {
    throw new Error(`task.workflow.js: repositoryManifest root checkoutPath (${rootOccurrence.checkoutPath}) does not match sourceRoot (${SOURCE_ROOT})`)
  }
  const mainRepoRoot = SOURCE_ROOT
  const sourceBranch = rootOccurrence.baseBranch
  // Snapshot canonical source paths before mergeTaskDeepestFirst substitutes task-worktree checkout paths during repository discovery.
  const sourceSubmodules = manifest.repositoryManifest.occurrences
    .filter((occurrence) => occurrence.parentOccurrenceId !== null)
    .map((occurrence) => ({ checkoutPath: occurrence.checkoutPath, depth: occurrence.depth }))
  const { stage: failedAtStage, ...report } = mergeTaskDeepestFirst(repoRoot, manifest)
  if (report.status !== 'merged') {
    return {
      stage: 'merge', task: N, failedAtStage, ...report,
      lastFailure: concreteMergeStageFailure({ ...report, stage: failedAtStage }),
    }
  }
  const rootLayer = report.completedLayers.find((layer) => layer.occurrenceId === 'root')
  const mergedCommitHash = rootLayer?.mergedCommitOid
  if (typeof mergedCommitHash !== 'string' || mergedCommitHash.length === 0) {
    return {
      stage: 'merge', task: N, status: 'blocked',
      lastFailure: 'root merge-time commit record is missing; refusing to archive the current source tip',
    }
  }
  const branch = currentBranchName(repoRoot)
  let closeResult
  try {
    closeResult = closeTasks([N], `merged to ${sourceBranch} at ${mergedCommitHash}`, mainRepoRoot, [mergedCommitHash])
  } catch (error) {
    const closeError = `close failure: ${String((error && error.message) || error)}`
    return {
      stage: 'merge', task: N, failedAtStage, ...report,
      status: 'merged-but-not-closed', mergedCommitHash,
      closeError, lastFailure: closeError,
    }
  }
  if (!closeResult.closed.includes(N)) {
    const closeError = `close failure: closeTasks did not close task ${N}: closed [${closeResult.closed.join(', ')}], skipped [${closeResult.skipped.join(', ')}], unblocked [${closeResult.unblocked.join(', ')}]`
    return {
      stage: 'merge', task: N, failedAtStage, ...report,
      status: 'merged-but-not-closed', mergedCommitHash,
      closed: closeResult.closed, skipped: closeResult.skipped, unblocked: closeResult.unblocked,
      closeError, lastFailure: closeError,
    }
  }
  try {
    deleteTaskMergePersistence(mainRepoRoot, branch)
    for (const target of sourceSubmodules) deleteTaskMergePersistence(target.checkoutPath, branch)
    removeTaskWorktreeAndBranches(mainRepoRoot, repoRoot, branch, sourceSubmodules)
  } catch (error) {
    const cleanupWarning = `failed final branch/worktree cleanup: ${String((error && error.message) || error)}`
    return { stage: 'merge', task: N, failedAtStage, ...report, mergedCommitHash, closed: closeResult.closed, unblocked: closeResult.unblocked, cleanupWarning }
  }
  return { stage: 'merge', task: N, failedAtStage, ...report, mergedCommitHash, closed: closeResult.closed, unblocked: closeResult.unblocked }
}

const STAGE_RUNNERS = {
  plan: async () => [await runPlan()],
  implement: async () => [await runImplement()],
  'rebase-test': async () => [await runRebaseTest()],
  merge: async () => [await runMerge()],
  'plan+implement': async () => {
    const planResult = await runPlan()
    if (planResult.status !== 'planned') return [planResult]
    return [planResult, await runImplement()]
  },
}

const runner = STAGE_RUNNERS[STAGE]
if (!runner) throw new Error(`task.workflow.js: unknown stage "${STAGE}"`)

return { task: N, stage: STAGE, results: await runner() }
