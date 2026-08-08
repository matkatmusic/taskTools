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

const fileRetryPreamble = (t, missingFiles) => `Before planning, run these two commands with Bash from ${ARGS.repo} to gain read access to the files you flagged as missing, then continue below:

1. cd ${ARGS.repo} && node "scripts/addTaskFiles.ts" '[${t.number}]' ${missingFiles.map((f) => JSON.stringify(f)).join(' ')}
2. cd ${ARGS.repo} && node -e "(async()=>{const {resolveTaskFiles,readTaskFile}=await import('./scripts/taskFiles.ts');const {writeTaskBriefFile}=await import('./scripts/prepareTasks.ts');const pair=resolveTaskFiles(process.cwd());const task=readTaskFile(pair.tasksPath).find(x=>x.taskNumber===${t.number});if(!task)throw new Error('task ${t.number} disappeared from tasks.json');writeTaskBriefFile(task,process.cwd());console.log(JSON.stringify(task.files));})()"

Command 1 adds the missing paths to this task's owned files in tasks.json.
Command 2 regenerates plans/brief-${t.number}.md from the updated task record and prints
the task's full current owned-files list as a JSON array on stdout — record that array,
you will return it as "files" below.

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
${preamble ? `Also return "files": the JSON array command 2 above printed.\n` : ''}
You are forbidden to edit any file other than ${t.planFile}${preamble ? ', tasks.json, and plans/brief-*.md — those only via the two commands given above' : ''}; to read a file outside
the owned list; to leave a decision for the implementer; or to write a plan step
whose exact target you did not read.`

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await spawn()
    if (result !== null && result !== undefined) return result
  }
  return null
}

const runPlan = async () => {
  log(`task ${N}: plan stage`)
  const { resolveTaskFiles, readTaskFile } = await import('./scripts/taskFiles.ts')
  const { writeTaskBriefFile } = await import('./scripts/prepareTasks.ts')
  const repoRoot = process.cwd()
  const pair = resolveTaskFiles(repoRoot)
  const task = readTaskFile(pair.tasksPath).find((entry) => entry.taskNumber === N)
  if (!task) throw new Error(`task.workflow.js: task ${N} not found in tasks.json`)
  const briefFile = writeTaskBriefFile(task, repoRoot)
  const preparedTask = {
    number: N,
    briefFile,
    planFile: `${repoRoot}/plans/task-${N}-plan.md`,
    files: Array.isArray(task.files) ? task.files : [],
    tests: task.tests,
  }
  const result = await retryAgent(() => agent(plannerBrief(preparedTask), { label: `plan:${N}`, phase: 'Plan', schema: PLAN_SCHEMA }))
  return {
    stage: 'plan',
    ...(result ?? {
      task: N,
      status: 'needs-clarification',
      planFile: '',
      question: 'planner returned no result after 3 attempts',
    }),
  }
}

const runImplement = () => {
  log(`task ${N}: implement stage (stub)`)
  return { stage: 'implement', task: N }
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
  implement: () => [runImplement()],
  'rebase-test': () => [runRebaseTest()],
  merge: () => [runMerge()],
  'plan+implement': async () => {
    const planResult = await runPlan()
    if (planResult.status !== 'planned') return [planResult]
    return [planResult, runImplement()]
  },
}

const runner = STAGE_RUNNERS[STAGE]
if (!runner) throw new Error(`task.workflow.js: unknown stage "${STAGE}"`)

return { task: N, stage: STAGE, results: await runner() }
