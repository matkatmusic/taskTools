# Task 134 plan — verify agent + VERIFY_SCHEMA.missingFiles in task.workflow.js's plan stage

## Scope and files

Owned files: `plans/task-86-spec.md`, `skills/tackle-tasks/task.workflow.js`,
`skills/tackle-tasks/verify.workflow.js`.

- `skills/tackle-tasks/task.workflow.js` — 3 edits (below).
- `skills/tackle-tasks/verify.workflow.js` — no edit. The brief is explicit:
  "Do not delete verify.workflow.js here — step 2 moves its remaining half
  across and deletes it then." This task only reads it as source material to
  copy from; step 2 of the split (a separate task) deletes it once the
  `applyFeedback` half has also been moved.
- `plans/task-86-spec.md` — no edit. It is the design doc this task
  implements a piece of; nothing in the brief asks it to change, and this
  task doesn't introduce any new design decision that spec doesn't already
  state (the `missingFiles` requirement is already written there under
  "stage `plan`").

## Design decisions (the "why" behind each edit)

1. **Why a new `VERIFY_SCHEMA` in task.workflow.js instead of reusing the one
   in verify.workflow.js:** verify.workflow.js's `VERIFY_SCHEMA` is scoped to
   its own file and stays there untouched per the brief. task.workflow.js
   needs its own copy for the same reason `PLAN_SCHEMA` already lives
   locally — each `.workflow.js` file is a standalone script executed by the
   harness with no shared imports between workflow files (confirmed by
   reading both files in full: neither imports from the other).

2. **Why `revised` is dropped from the new `VERIFY_SCHEMA`, even though the
   old one had it:** In verify.workflow.js, `revised` tracks whether the
   *same* agent both reviewed and then patched the plan itself before a
   second review pass (see verify.workflow.js:66-80, the "Apply those fixes
   to `${planFile}` ... run that same reviewer's command a second time"
   block). The brief is explicit that this task moves only the reviewing
   half — "today one agent both reviews and applies fixes; this task takes
   only the reviewing" — so the new verify agent never edits the plan and
   never re-reviews. A field that would always be `false` is dead weight, so
   it isn't carried over. Nothing in the "done when" criteria requires it.

3. **Why `missingFiles` is populated via a `MISSING_FILES:` text section in
   the codex prompt rather than asking codex to emit JSON directly:** codex
   runs as an external CLI (`codex exec`) whose entire output is captured as
   plain text and interpreted by the Claude agent that invoked it (see
   verify.workflow.js:39-57 — the agent runs the codex command, then reads
   its printed APPROVED/REJECTED/PROBLEMS/FIXES text). Keeping the
   REJECTED-path shape (a labeled text section) matches how APPROVED/
   PROBLEMS/FIXES already work, so the Claude agent that already parses
   those markers can parse one more the same way, rather than asking codex
   (an external tool with an established plain-text convention here) to
   switch to structured JSON output mid-review.

4. **Why the verify call sits inside `runPlan()` rather than being a new
   entry in `STAGE_RUNNERS`:** the "done when" criterion says the verify
   agent runs "inside the plan stage of task.workflow.js" — `runPlan()` is
   that stage's implementation, and `STAGE_RUNNERS.plan` is `async () =>
   [await runPlan()]`, so anything added inside `runPlan()` automatically
   participates in both the `plan` stage and the `plan+implement` default
   without a second edit site.

5. **Why the verify agent only runs when `planResult.status === 'planned'`:**
   there is nothing to review when the planner returned
   `needs-clarification` or `not-relevant` — no plan file was written in
   those cases (see plannerBrief's instructions in task.workflow.js:69-72),
   so a review agent would have nothing to read.

6. **Why the result is attached as `verify` on the returned object instead of
   as a second array entry:** `STAGE_RUNNERS['plan+implement']` gates on
   `planResult.status` (task.workflow.js:137-139: `if (planResult.status !==
   'planned') return [planResult]`). Keeping `verify` as a property on the
   same object (`{ ...planResult, verify }`) means that existing gate keeps
   working unchanged — it reads `.status` off the same object it always did
   — and nothing about the array shape `STAGE_RUNNERS` returns needs to
   change for this task. (Steps 2 and 3 of this split, which add the
   3-round loop and the `applyFeedback` agent, are the ones that will decide
   how multiple rounds accumulate; this task only needs one round to exist.)

## Edits to `skills/tackle-tasks/task.workflow.js`

### Edit 1 — add `VERIFY_SCHEMA` after `PLAN_SCHEMA`

Current text (lines 26-29):

```
  required: ['task', 'status', 'planFile', 'question'],
}

const fileRetryPreamble = (t, missingFiles) => `Before planning, run these two commands with Bash from ${ARGS.repo} to gain read access to the files you flagged as missing, then continue below:
```

Becomes:

```
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

const fileRetryPreamble = (t, missingFiles) => `Before planning, run these two commands with Bash from ${ARGS.repo} to gain read access to the files you flagged as missing, then continue below:
```

(Only the blank line + new `VERIFY_SCHEMA` block is inserted between the
closing `}` of `PLAN_SCHEMA` and the `const fileRetryPreamble` line; nothing
else on those lines changes.)

### Edit 2 — add `codexPrompt` and `verifierBrief` after `plannerBrief`

Current text (task.workflow.js:77-80, the end of `plannerBrief` through the
start of `retryAgent`):

```
whose exact target you did not read.`

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
```

Becomes:

```
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

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
```

### Edit 3 — call the verify agent at the end of `runPlan()`

Current text (task.workflow.js:104-114, the end of `runPlan`):

```
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
```

Becomes:

```
  const result = await retryAgent(() => agent(plannerBrief(preparedTask), { label: `plan:${N}`, phase: 'Plan', schema: PLAN_SCHEMA }))
  const planResult = {
    stage: 'plan',
    ...(result ?? {
      task: N,
      status: 'needs-clarification',
      planFile: '',
      question: 'planner returned no result after 3 attempts',
    }),
  }
  if (planResult.status !== 'planned') return planResult
  const verify = await retryAgent(() => agent(verifierBrief(preparedTask, preparedTask.planFile), { label: `verify:${N}`, phase: 'Plan', schema: VERIFY_SCHEMA })) ?? {
    task: N,
    verdict: 'rejected',
    notes: 'verifier agent returned no result after 3 attempts (killed, errored, or blocked)',
    reviewer: 'none',
    missingFiles: [],
  }
  return { ...planResult, verify }
}
```

Nothing else in the file changes. `STAGE_RUNNERS`, `runImplement`,
`runRebaseTest`, `runMerge`, and the final `return { task: N, stage: STAGE,
results: await runner() }` line are all untouched and need no edit — none of
them reference `runPlan`'s internals beyond the `.status`/array shape that
Edit 3 preserves.

## Order of edits

Apply Edit 1, then Edit 2, then Edit 3, in that order — each is a
non-overlapping, independently-anchored insertion/replacement, so order
between them doesn't affect correctness, but applying top-to-bottom avoids
re-deriving line numbers after each edit shifts the file.

## Verification

Run these from the repo root (`/Users/matkatmusicllc/Programming/taskTools-86`)
after all three edits are applied.

1. **Syntax check** — the file's top-level `return` and `export const meta`
   make it invalid as a plain ES module or CommonJS script, so wrap it as an
   async function body for the check (mirrors how the harness executes it)
   and swap `export const meta` for `const meta` only inside that wrapper
   (never edit the real file with this substitution — the command below
   only pipes through `sd` with no file argument, so `sd` reads stdin and
   writes to stdout, never touching the file on disk):

   ```
   node --check <(printf 'async function __check() {\n'; cat skills/tackle-tasks/task.workflow.js | sd '^export const meta' 'const meta'; printf '}\n'); echo "exit:$?"
   ```

   Expected: `exit:0` printed, with no `SyntaxError` output before it.

2. **New symbols present, exactly once each:**

   ```
   rg -F -c "const VERIFY_SCHEMA = {" skills/tackle-tasks/task.workflow.js
   rg -F -c "const codexPrompt = (t, planFile) =>" skills/tackle-tasks/task.workflow.js
   rg -F -c "const verifierBrief = (t, planFile) => {" skills/tackle-tasks/task.workflow.js
   rg -F -c 'label: `verify:${N}`' skills/tackle-tasks/task.workflow.js
   rg -F -c "MISSING_FILES:" skills/tackle-tasks/task.workflow.js
   ```

   Expected: each command prints `1`.

3. **`verify.workflow.js` and `plans/task-86-spec.md` are untouched:**

   ```
   git diff --stat -- skills/tackle-tasks/verify.workflow.js plans/task-86-spec.md
   ```

   Expected: no output (empty diff — neither file changed).

4. **The diff on `task.workflow.js` is exactly the three edits above, no
   more:**

   ```
   git diff -- skills/tackle-tasks/task.workflow.js
   ```

   Expected: three hunks — one inserting the `VERIFY_SCHEMA` block after
   `PLAN_SCHEMA`, one inserting `codexPrompt` and `verifierBrief` after
   `plannerBrief`, and one changing `runPlan`'s final `return` block into the
   `planResult` / early-return / `verify` block shown in Edit 3. No other
   lines in the file should appear in the diff.
