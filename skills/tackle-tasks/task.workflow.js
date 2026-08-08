const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const N = ARGS.task
const STAGE = ARGS.stage ?? 'plan+implement'

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

const runImplement = async () => {
  log(`task ${N}: implement stage (stub)`)
  if (!preparedTask) preparedTask = await loadPreparedTask()
  return { stage: 'implement', task: N, files: preparedTask.files }
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
