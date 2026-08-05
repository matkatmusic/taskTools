export const meta = {
  name: 'tackle-tasks-test',
  description: 'Run the tests covering each group and have a worker fix failures until they pass',
  phases: [
    { title: 'Test', detail: 'report-only test run per group, repeated until green' },
    { title: 'Fix', detail: 'one worker per failing task between test rounds' },
  ],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const GROUPS = ARGS.groups ?? []
const DONE = ARGS.done ?? []
const TYPECHECK_COMMAND = ARGS.typecheckCommand ?? 'npx tsc --noEmit'
const MAX_ROUNDS = ARGS.maxRounds ?? 3

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task: { type: 'integer' }, detail: { type: 'string' } },
        required: ['task', 'detail'],
      },
    },
  },
  required: ['passed', 'failures'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    fixed: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['task', 'fixed', 'summary'],
}

const testerBrief = (group, tasks) => `cd ${group.worktree}.
These tasks just committed changes to these files:
${tasks.map((t) => `- task ${t.number}: ${t.files.join(', ')}`).join('\n')}

Report only — do not edit any file. First run: ${TYPECHECK_COMMAND}
Then find and run the tests covering these files: check for a related-test
discovery command in this repo (e.g. scripts/relatedTests.ts) before falling
back to running each file's own test file directly. Do not run the full suite.

Return passed=true only if typecheck is clean AND every discovered test
passes. Otherwise passed=false and, for each task whose files have a failing
test or type error, add an entry to failures: {task: <task number>, detail:
<failing test names and a short error summary>}.
Return {passed, failures}.`

const fixerBrief = (t, group, detail) => `cd ${group.worktree}.
A test run found this failure in files you own (${t.files.join(', ')}):

${detail}

Fix it. Touch nothing outside the files you own, and do not weaken or delete
a test to make it pass — fix the cause. Re-run the affected tests and
${TYPECHECK_COMMAND} to confirm.

When it is green, commit from ${group.worktree}, staging ONLY your own paths —
never \`git add -A\`, never \`git add .\`:
  git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}
  git commit -m "task ${t.number}: fix failing test"

If you cannot fix it, set fixed=false and say why in summary.
Return {task: ${t.number}, fixed, summary}.`

async function testGroup(group) {
  const tasks = group.tasks.filter((t) => DONE.some((d) => d.task === t.number))
  if (!tasks.length) return { groupId: group.groupId, passed: true, rounds: 0, failures: [], notes: 'no implemented tasks to test' }

  const taskByNumber = new Map(tasks.map((t) => [t.number, t]))
  let outcome = null

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const result = await agent(testerBrief(group, tasks), {
      label: `test:${group.groupId}:r${round}`,
      phase: 'Test',
      effort: 'low',
      schema: TEST_SCHEMA,
    })
    outcome = result ?? { passed: false, failures: tasks.map((t) => ({ task: t.number, detail: 'test agent returned no result' })) }

    if (outcome.passed) return { groupId: group.groupId, passed: true, rounds: round, failures: [], notes: '' }
    if (round === MAX_ROUNDS) break

    const fixable = outcome.failures.filter((f) => taskByNumber.has(f.task))
    if (!fixable.length) break

    log(`group ${group.groupId} round ${round}: fixing ${fixable.length} failing task(s)`)
    await parallel(fixable.map((f) => () =>
      agent(fixerBrief(taskByNumber.get(f.task), group, f.detail), {
        label: `fix:${f.task}:r${round}`,
        phase: 'Fix',
        schema: FIX_SCHEMA,
      })))
  }

  return {
    groupId: group.groupId,
    passed: false,
    rounds: MAX_ROUNDS,
    failures: outcome?.failures ?? [],
    notes: `still failing after ${MAX_ROUNDS} round(s)`,
  }
}

log(`testing ${GROUPS.length} group(s), up to ${MAX_ROUNDS} round(s) each`)
const tests = (await parallel(GROUPS.map((g) => () => testGroup(g)))).filter(Boolean)

return { tests, allPassed: tests.every((t) => t.passed) }
