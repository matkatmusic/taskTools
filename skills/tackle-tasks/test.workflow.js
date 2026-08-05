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

const testerBrief = (group, tasks) => `Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

run(cd ${group.worktree})
ownedFiles = {
${tasks.map((t) => `    task ${t.number}: ${t.files.join(', ')}`).join('\n')}
}
failures = []

typecheck = run(${TYPECHECK_COMMAND})

if scripts/relatedTests.ts exists:
    tests = run it to discover the tests covering ownedFiles
else:
    tests = the test file belonging to each file in ownedFiles
// never run the full suite

results = run(tests)

for each task in ownedFiles:
    if typecheck reported an error in that task's files, or any of its tests failed:
        failures += {task: that task number, detail: the failing test names plus a short error summary}

if typecheck is clean and every test in results passed:
    return {passed: true, failures: []}
else:
    return {passed: false, failures: failures}

You are forbidden to edit any file, to run the full suite, or to report passed
true while any test failed or typecheck reported an error.`

const planFileFor = (task) => (ARGS.approved ?? []).find((a) => a.task === task)?.planFile ?? ''

const fixerBrief = (t, group, detail) => `You implemented task #${t.number} and wrote its tests. One of them
is now failing.

Carry out every step below, in order, from top to bottom.
A line reading \`name = value\` means record that value and use it later.
A line reading \`run(...)\` means actually execute that command now.
A line reading \`return {...}\` means stop and report exactly those fields.

run(cd ${group.worktree})
ownedFiles = ${t.files.join(', ')}
plan = ${planFileFor(t.number) || '(no plan file recorded)'}
failure = ${detail}

read(plan)   // the fix must match what the task set out to do

if the plan is wrong:
    return {task: ${t.number}, fixed: false, summary: why the plan itself is wrong}
else if the code is wrong:
    fix the code so the test passes as written
else if the test asserts something the plan did not call for:
    correct the test to assert what the plan called for
    note in summary that you changed the test, and why

typecheck = run(${TYPECHECK_COMMAND})
results = run(the tests covering ownedFiles)

if typecheck is clean and every test passed:
    run: git add -- ${t.files.map((f) => JSON.stringify(f)).join(' ')}
    run: git commit -m "task ${t.number}: fix failing test"
    return {task: ${t.number}, fixed: true, summary: what you changed}
else:
    return {task: ${t.number}, fixed: false, summary: what is still failing}

You are forbidden to touch anything outside ownedFiles; to weaken, skip, or
delete a test to make it pass; to assert the current wrong output as the
expected value; to run \`git add -A\` or \`git add .\`; to commit while anything
fails; or to redecide the plan yourself.`

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

const testReceipts = tests.map((t) => ({ groupId: String(t.groupId), status: t.passed ? 'green' : 'red' }))

return { tests, allPassed: tests.every((t) => t.passed), testReceipts }
