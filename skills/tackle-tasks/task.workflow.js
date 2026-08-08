const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const N = ARGS.task
const STAGE = ARGS.stage ?? 'plan+implement'
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
const WORKER_MODEL = ARGS.workerModel
const MAX_FIX_ROUNDS = ARGS.maxRounds ?? 3

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

const fileRetryPreamble = (missingFiles) => `Before planning: the workflow has already widened this task's owned files in tasks.json to include ${missingFiles.join(', ')} and regenerated the brief file — you do not need to run any command for this. The owned-files list below already includes the paths you previously flagged as missing.

`

const testsInstruction = (t) => t.tests && t.tests !== 'skip'
  ? `The task's tests field holds an example test the user wrote — put it into the plan's verification section as the concrete check to run, expanded with a few extra cases covering the individual functions/subparts it touches: ${t.tests}`
  : 'This task has no tests field, or it is the literal string "skip" — do not require TDD; write ordinary verification commands in the plan instead.'

const plannerBrief = (t, preamble = '') => `${preamble}Invoke /ponytail:ponytail ultra.
Read this brief file: ${t.briefFile}
You may also READ these owned files, and nothing else: ${t.files.join(', ')}
Read them — a plan that guesses at their contents will be rejected by the reviewer.
Follow ~/.claude/guides/planning.md and write the plan to exactly this path: ${t.planFile}
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

If the plan would need to edit a file outside the owned list above, set status
"needs-clarification" and name that file in "question" — do not plan the edit anyway.
If the blocker is instead that you need to READ a file outside the owned list
to write an exact plan, set status "needs-clarification", populate
missingFiles with the repo-relative path(s) of each file you need, and use
"question" to explain why each path is needed.
If the task is unclear, set status "needs-clarification" and put your
question in "question". If the task no longer applies to the codebase, set
status "not-relevant" and explain why in "question". Otherwise write the
plan file and set status "planned".
Return {task: ${t.number}, status, planFile: "${t.planFile}", question, missingFiles}.
You are forbidden to edit any file other than ${t.planFile}; to read a file outside
the owned list; to leave a decision for the implementer; or to write a plan step
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

const workerBrief = (t, note) => `You are implementing EXACTLY ONE pre-planned task from
./.taskTools/tasks.json: #${t.number}.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

ownedFiles = ${t.files.join(', ')}
plan = ${t.planFile}
notesFile = ${t.notesFile}
timeBudget = 10 minutes
${note ? `note = ${note}\n` : ''}
${tddInstruction(t)}

use jot:implement ${t.planFile}, writing its implementation-notes log to exactly notesFile

if the plan is impossible as written:
    return {task: ${t.number}, status: "blocked", summary: why it cannot be done, remaining: [], notesFile: notesFile}

implement every step of the plan, editing only ownedFiles

typecheck = run(${TYPECHECK_COMMAND})
if typecheck reported errors in ownedFiles:
    fix them

if scripts/relatedTests.ts exists:
    tests = run it to discover the tests covering ownedFiles
else:
    tests = the test file belonging to each file in ownedFiles
// never run the full suite; that is the close-tasks gate, not yours

results = run(tests)
fixRound = 0
while any test failed and fixRound is less than ${MAX_FIX_ROUNDS}:
    fixRound = fixRound + 1
    fix the cause
    typecheck = run(${TYPECHECK_COMMAND})
    results = run(tests)

if any test still failed after ${MAX_FIX_ROUNDS} fix rounds:
    return {task: ${t.number}, status: "blocked", summary: what is still failing after ${MAX_FIX_ROUNDS} fix rounds, remaining: the failing test names, notesFile: notesFile}

if typecheck is clean and every test passed:
    run: ${t.files.length ? `git add -- ${[...t.files, t.notesFile].map((f) => JSON.stringify(f)).join(' ')}` : `git add -- ${JSON.stringify(t.notesFile)} (plus every other path you edited, listed explicitly)`}
    run: git commit -m "task ${t.number}: one-line summary"
    return {task: ${t.number}, status: "done", summary: one sentence, remaining: [], notesFile: notesFile}
else if part of the plan is implemented:
    return {task: ${t.number}, status: "partial", summary: one sentence, remaining: the plan steps not yet done, plus any failing test names, notesFile: notesFile}
else:
    return {task: ${t.number}, status: "blocked", summary: one sentence, remaining: the failing test names, notesFile: notesFile}

if you reach timeBudget before finishing:
    return status "partial" with the not-yet-done plan steps in remaining, notesFile still set to notesFile

You are forbidden to touch anything outside ownedFiles excluding notesFile; to
add scope or refactors the plan does not call for; to redecide anything the
plan already decided; to run the full suite, \`git add -A\`, or \`git add .\`; to
commit while anything fails; to attempt more than ${MAX_FIX_ROUNDS} fix
rounds; or to return status "done" with a failing test. Any test file created
or modified must be listed in ownedFiles; otherwise return status "blocked"
without editing it.`

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
  const { resolveTaskFiles, readTaskFile } = await import('./scripts/taskFiles.ts')
  const { writeTaskBriefFile } = await import('./scripts/prepareTasks.ts')
  const repoRoot = process.cwd()
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

const runPlan = async () => {
  log(`task ${N}: plan stage`)
  preparedTask = await loadPreparedTask()
  const { execFileSync } = await import('node:child_process')
  const { readTaskFile } = await import('./scripts/taskFiles.ts')
  const { writeTaskBriefFile } = await import('./scripts/prepareTasks.ts')
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
  if (planResult.status !== 'planned') return planResult
  const runVerify = async () => await retryAgent(() => agent(verifierBrief(preparedTask, preparedTask.planFile), { label: `verify:${N}`, phase: 'Plan', schema: VERIFY_SCHEMA })) ?? {
    task: N,
    verdict: 'rejected',
    notes: 'verifier agent returned no result after 3 attempts (killed, errored, or blocked)',
    reviewer: 'none',
    missingFiles: [],
  }
  const widenFilesAndReplan = async (missingFiles) => {
    execFileSync('node', ['scripts/addTaskFiles.ts', JSON.stringify([N]), ...missingFiles], { cwd: preparedTask.repoRoot })
    const widenedTask = readTaskFile(preparedTask.pair.tasksPath).find((entry) => entry.taskNumber === N)
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

const runRebaseTest = () => {
  log(`task ${N}: rebase-test stage (stub)`)
  return { stage: 'rebase-test', task: N }
}

const runMerge = () => {
  log(`task ${N}: merge stage (stub)`)
  return { stage: 'merge', task: N }
}

const STAGE_RUNNERS = {
  plan: async () => [await runPlan()],
  implement: async () => [await runImplement()],
  'rebase-test': () => [runRebaseTest()],
  merge: () => [runMerge()],
  'plan+implement': async () => {
    const planResult = await runPlan()
    if (planResult.status !== 'planned') return [planResult]
    return [planResult, await runImplement()]
  },
}

const runner = STAGE_RUNNERS[STAGE]
if (!runner) throw new Error(`task.workflow.js: unknown stage "${STAGE}"`)

return { task: N, stage: STAGE, results: await runner() }
