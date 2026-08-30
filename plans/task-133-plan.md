# Task 133 plan: fill in the plan stage of task.workflow.js

## Decisions (resolved, not conditional)

1. **`plan.workflow.js` is not deleted in this task.** The brief's Goal section
   overrides the Description's "then delete plan.workflow.js" phrasing:
   "Deleting plan.workflow.js is NOT part of this task — the old workflow
   files are removed at the end of the chain." So `plannerBrief`, `PLAN_SCHEMA`,
   `retryAgent`, and `fileRetryPreamble` are **copied** into `task.workflow.js`;
   `plan.workflow.js` stays byte-identical.
2. **`testsInstruction` moves too, even though it isn't named in the four.**
   `plannerBrief`'s body calls `testsInstruction(t)` on its own line
   (`- ${testsInstruction(t)}`). Moving `plannerBrief` "unchanged" without its
   callee would leave a `ReferenceError` at call time, so `testsInstruction` is
   a forced dependency of the four named moves, not an added scope.
3. **The multi-task retry-with-missing-files loop (`needsFileRetry`,
   `retryWithFiles`) is NOT ported.** The Work list names only `plannerBrief`,
   `PLAN_SCHEMA`, `retryAgent`, `fileRetryPreamble` to move, and the Goal's
   "done when" criterion is: brief is written, planner agent runs, and it
   produces `plans/task-<N>-plan.md`. That does not require the missing-files
   retry loop. `fileRetryPreamble` is moved and exists in `task.workflow.js`
   (satisfying "now live in task.workflow.js") but is not called from
   `runPlan`; nothing currently calls it.
4. **`runPlan` looks up the `TaskRecord` itself.** `task.workflow.js`'s `ARGS`
   currently carries only `.task` and `.stage` (no task title/description/
   files, no repo path) — unlike `plan.workflow.js`'s `ARGS.groups`, which
   arrived pre-built by `prepareTasks.ts`. To get a `TaskRecord` (needed by
   `writeTaskBriefFile` and by `plannerBrief`'s file list), `runPlan` reads
   `tasks.json` directly via `resolveTaskFiles` + `readTaskFile` from
   `scripts/taskFiles.ts`, filtering for `taskNumber === N`.
5. **Module loading uses relative dynamic `import()` from inside `runPlan`,
   not a static top-of-file `import`.** Neither `task.workflow.js` nor
   `plan.workflow.js` contains any `import` statement today, and
   `task.workflow.js` already runs code the static-ESM spec forbids (a
   top-level `return`), so its execution harness is not a plain ES module —
   static `import` syntax is unproven in it. The one proven-working pattern in
   these owned files is `fileRetryPreamble`'s own generated command:
   `await import('./scripts/taskFiles.ts')` / `await import('./scripts/prepareTasks.ts')`,
   run via `node -e` from the repo root — the exact form this very planning
   task's preamble ran as its command 2. `runPlan` reuses that identical
   relative-path, dynamic-`import()` form.
6. **`repoRoot` is `process.cwd()`.** The chain goal states `task.workflow.js`
   "produces that task's plan inside that worktree," and `prepareTasks.ts`'s
   own CLI entry point uses `const repoRoot = process.cwd();` for the same
   purpose (writing briefs/plans under `<repoRoot>/plans/`). `runPlan` mirrors
   that.
7. **`runPlan`'s stubbed return field `{ stage: 'plan', task: N }` becomes
   `{ stage: 'plan', ...plannerResult }`**, keeping the `stage` field for
   parity with the three still-stubbed runners (`runImplement`,
   `runRebaseTest`, `runMerge` all return an object with a `stage` key), while
   spreading in the planner's real `{task, status, planFile, question,
   missingFiles?}` result (or the same null-result fallback object
   `plan.workflow.js` used for a planner that returns nothing after 3
   attempts).
8. **`plan` and `plan+implement` each await `runPlan()` before returning, and
   `plan+implement` gates `runImplement()` on the plan's outcome.**
   `STAGE_RUNNERS.plan` becomes `async () => [await runPlan()]`.
   `STAGE_RUNNERS['plan+implement']` becomes an async function that awaits
   `runPlan()`, returns `[planResult]` alone when `planResult.status !==
   'planned'` (covering `needs-clarification`, `not-relevant`, and the
   null-result fallback), and only then calls `runImplement()` and returns
   `[planResult, runImplement()]`. This stops `runImplement` from starting
   either before the plan settles or after a plan that never reached
   `'planned'`. The still-stubbed `implement`, `rebase-test`, and `merge`
   runners are unaffected and keep returning a plain array synchronously. The
   final dispatch line becomes `results: await runner()` (not
   `Promise.all(runner())`): every `STAGE_RUNNERS` entry now returns either a
   plain array or a promise of one, and `await` handles both.
9. **`preparedTask` carries `tests: task.tests`.** `plannerBrief` (moved
   unchanged) calls `testsInstruction(t)`, which reads `t.tests`. Without
   forwarding `task.tests` onto `preparedTask`, `t.tests` is always
   `undefined` and `testsInstruction` always emits the no-tests branch,
   silencing any task that has a real `tests` field. `TaskRecord`'s `tests`
   value (whatever `tasks.json` holds for that field, including `undefined`
   when absent) is passed through as-is — `testsInstruction` already branches
   on `t.tests && t.tests !== 'skip'`, so `undefined` and `'skip'` both still
   take the no-tests branch correctly.

## Edits

### skills/tackle-tasks/task.workflow.js

Replace lines 16–47 (everything after the `meta` block: the stub `runPlan`
through the final dispatch line) with the new block below. Lines 1–15
(the `ARGS`/`N`/`STAGE` declarations and the `meta` export) are unchanged.

**Current text, lines 16–47:**

```
const runPlan = () => {
  log(`task ${N}: plan stage (stub)`)
  return { stage: 'plan', task: N }
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
  plan: () => [runPlan()],
  implement: () => [runImplement()],
  'rebase-test': () => [runRebaseTest()],
  merge: () => [runMerge()],
  'plan+implement': () => [runPlan(), runImplement()],
}

const runner = STAGE_RUNNERS[STAGE]
if (!runner) throw new Error(`task.workflow.js: unknown stage "${STAGE}"`)

return { task: N, stage: STAGE, results: runner() }
```

**Becomes:**

```
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
```

This makes the resulting file 146 lines total. Predicted line numbers of the
new top-level declarations, for verification below:
`PLAN_SCHEMA` at line 16, `fileRetryPreamble` at line 29, `testsInstruction`
at line 41, `plannerBrief` at line 45, the `// ponytail:` comment + `retryAgent`
at lines 79–86, `runPlan` at line 88, `STAGE_RUNNERS` at line 131, the
`runner`/dispatch lines at lines 143–146.

### skills/tackle-tasks/plan.workflow.js

No edit. Per Decision 1, deleting this file (and therefore emptying it) is
explicitly out of scope for this task; its content is copied, not moved, so
it stays byte-identical to what was read.

### scripts/prepareTasks.ts

No edit. The task's Work list says `writeTaskBriefFile` "already exists in
scripts/prepareTasks.ts — reuse it, do not re-implement brief formatting."
`task.workflow.js`'s new `runPlan` imports and calls the existing exported
`writeTaskBriefFile(task, repoRoot)` (line 333 of this file) as-is; nothing
in this file needs to change to support that.

### scripts/taskFiles.ts

No edit. `runPlan` imports and calls the existing exported `resolveTaskFiles`
(line 16) and `readTaskFile` (line 49) as-is to look up the `TaskRecord` for
`N`; nothing in this file needs to change to support that.

## Verification

Run all of the following from `/Users/matkatmusicllc/Programming/taskTools-86`.

1. Confirm the moved blocks are byte-identical to their `plan.workflow.js`
   source (each diff must produce no output):

```
diff <(sed -n '11,22p' skills/tackle-tasks/plan.workflow.js) <(sed -n '16,27p' skills/tackle-tasks/task.workflow.js)
diff <(sed -n '24,34p' skills/tackle-tasks/plan.workflow.js) <(sed -n '29,39p' skills/tackle-tasks/task.workflow.js)
diff <(sed -n '36,38p' skills/tackle-tasks/plan.workflow.js) <(sed -n '41,43p' skills/tackle-tasks/task.workflow.js)
diff <(sed -n '40,72p' skills/tackle-tasks/plan.workflow.js) <(sed -n '45,77p' skills/tackle-tasks/task.workflow.js)
diff <(sed -n '77,84p' skills/tackle-tasks/plan.workflow.js) <(sed -n '79,86p' skills/tackle-tasks/task.workflow.js)
```

Expected: all five commands print nothing (identical `PLAN_SCHEMA`,
`fileRetryPreamble`, `testsInstruction`, `plannerBrief`, and the
`// ponytail:` comment + `retryAgent`, respectively).

2. Confirm `plan.workflow.js`, `scripts/prepareTasks.ts`, and
   `scripts/taskFiles.ts` were not touched:

```
git diff --stat -- skills/tackle-tasks/plan.workflow.js scripts/prepareTasks.ts scripts/taskFiles.ts
```

Expected: empty output (no lines).

3. Confirm the plan stage actually plans, and confirm `plan+implement` never
   starts the implement stage on a plan that didn't reach `'planned'`. Save
   the following as `/tmp/verify-task-133-plan-stage.mjs`:

```js
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realRepoRoot = process.cwd();
const repoRoot = mkdtempSync(join(tmpdir(), 'task133-verify-'));
mkdirSync(join(repoRoot, 'plans'), { recursive: true });
symlinkSync(join(realRepoRoot, 'scripts'), join(repoRoot, 'scripts'));

const task = {
  taskNumber: 999001,
  title: 'fixture task',
  description: 'fixture description',
  files: ['scripts/taskFiles.ts'],
  tests: 'assert(1 === 1)',
};
writeFileSync(join(repoRoot, 'tasks.json'), JSON.stringify([task]));

const code = readFileSync(join(realRepoRoot, 'skills/tackle-tasks/task.workflow.js'), 'utf8')
  .replace('export const meta', 'const meta');
const run = new Function('args', 'log', 'agent', 'parallel', 'return (async () => {' + code + '})()');

process.chdir(repoRoot);

let failures = 0;
const check = (name, condition) => {
  console.log(condition ? `PASS ${name}` : `FAIL ${name}`);
  if (!condition) failures++;
};

// Case 1: planner returns "planned" under the plan stage.
{
  const seenPrompts = [];
  const planFile = join(repoRoot, 'plans', 'task-999001-plan.md');
  const plannedAgent = async (prompt) => {
    seenPrompts.push(prompt);
    writeFileSync(planFile, '# fixture plan\n');
    return { task: 999001, status: 'planned', planFile, question: '' };
  };
  const result = await run(
    JSON.stringify({ task: 999001, stage: 'plan' }),
    (...a) => console.log('LOG', ...a),
    plannedAgent,
    async (fns) => Promise.all(fns.map((f) => f())),
  );
  check('brief file written', existsSync(join(repoRoot, 'plans', 'brief-999001.md')));
  check('prompt names the exact brief path', seenPrompts[0].includes(join(repoRoot, 'plans', 'brief-999001.md')));
  check('prompt names the exact plan path', seenPrompts[0].includes(planFile));
  check('prompt carries the task-specific test instruction', seenPrompts[0].includes('assert(1 === 1)'));
  check('plan file written', existsSync(planFile));
  check('returned status is planned', result.results[0].status === 'planned');
}

// Case 2: planner returns "needs-clarification" under plan+implement — implement must not run.
{
  const logs = [];
  const clarifyAgent = async () => ({ task: 999001, status: 'needs-clarification', planFile: '', question: 'fixture question' });
  const result = await run(
    JSON.stringify({ task: 999001, stage: 'plan+implement' }),
    (...a) => logs.push(a.join(' ')),
    clarifyAgent,
    async (fns) => Promise.all(fns.map((f) => f())),
  );
  check('implement stage never logs when plan is not planned', !logs.some((line) => line.includes('implement stage')));
  check('plan+implement returns only the plan result when not planned', result.results.length === 1 && result.results[0].status === 'needs-clarification');
}

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

Run it from `/Users/matkatmusicllc/Programming/taskTools-86`:

```
node /tmp/verify-task-133-plan-stage.mjs
```

Expected: every `check(...)` line prints `PASS ...` (no `FAIL ...` line), the
last line is `ALL CHECKS PASSED`, exit code 0.

4. Confirm the exact relative dynamic-`import()` pattern `runPlan` uses
   resolves cleanly from the repo root (same mechanism `fileRetryPreamble`'s
   own generated command already relies on):

```
node -e "(async()=>{const {resolveTaskFiles,readTaskFile}=await import('./scripts/taskFiles.ts');const {writeTaskBriefFile}=await import('./scripts/prepareTasks.ts');console.log(typeof resolveTaskFiles, typeof readTaskFile, typeof writeTaskBriefFile)})()"
```

Expected output: `function function function`.

5. Confirm only `task.workflow.js` shows as a modified source file:

```
git status --porcelain -- skills/tackle-tasks scripts
```

Expected: only ` M skills/tackle-tasks/task.workflow.js` (no lines for
`plan.workflow.js`, `prepareTasks.ts`, or `taskFiles.ts`).
