# Task 55 plan: fall back to a Claude reviewer in verify.workflow.js when codex is unavailable

## Design decisions (settled, not left for the implementer)

1. **Default fallback reviewer: `model: 'fable'`, `effort: 'medium'`.** The
   brief frames the whole feature as existing "to keep token cost down" and
   explicitly labels `fable`/`medium` "the cheaper option" of the two named
   choices (`opus`/`high` vs `fable`/`medium`). Per that stated cost goal,
   `fable`/`medium` is the default and the only reviewer built into the code.
   `opus`/`high` is not wired in as a switchable alternative — nothing in the
   brief asks for it to be selectable, so building an unused switch would be
   speculative (YAGNI).
2. **Reviewer is chosen fresh on every round, not locked per task.** Each
   round (round 1, and the round-2 repair re-review) independently calls
   codex first; only when that call comes back "unavailable" does the round
   fall back to `fable`. Round 2 is not forced onto the fallback just because
   round 1 used it — if codex has recovered by round 2, round 2 asks codex
   again — and round 1 is not forced onto codex just because a prior task's
   round used the fallback. This is the direct "on unavailability" trigger
   the brief describes, applied per round, instead of inventing "reviewer
   switched/locked mid-task" semantics the brief never asks for.
3. **"Review" (for the twice-ceiling) means one verdict-bearing round result
   (approved/rejected), not each individual model call.** A round that
   probes codex, finds it unavailable, and then gets a verdict from the
   fallback still counts as exactly one of the two allowed reviews — the
   codex probe produced no verdict, so it's not a review by itself, but the
   round as a whole (codex-probe-then-fallback) is. Only round 1 and round 2
   verdicts count toward the ceiling, matching today's at-most-two-reviews
   behavior.
4. **Edge case: codex is unavailable for a round, and the fallback itself
   also fails to return anything (killed/errored/blocked).** This is a
   distinct outcome from an ordinary codex-unavailable round (decision 2
   already handles that by calling the fallback). It means neither reviewer
   produced any verdict for that round at all. Treat it as a round status of
   `'unavailable'` and reject the task immediately without a second round:
   `revised: false` if this happens on round 1, `revised: true` if it happens
   on round 2 (a fix was already applied before the failed round-2 attempt).
   The notes explain that both reviewers were unavailable. This is a
   deliberate degrade-to-rejected choice for a rare double-failure, not a
   gap left for the implementer.
5. **The fallback reviewer gets its own prompt (`fallbackPrompt`), not
   `codexPrompt` reused verbatim, and its own schema (`FALLBACK_SCHEMA`)
   whose `status` enum is only `['approved', 'rejected']` — never
   `'unavailable'`.** `codexPrompt`'s response-format instructions
   ("print APPROVED or REJECTED alone on the first line... PROBLEMS:...
   FIXES:...") are written for a subagent that parses codex's raw stdout
   line-by-line; they do not describe how to fill in the four separate
   `{status, reasoning, problems, fixes}` fields `agent()`'s schema
   validation requires. Passing `codexPrompt`'s text unchanged to a
   schema-validated `agent()` call asks the model to follow two incompatible
   output-format instructions at once. `fallbackPrompt` keeps `codexPrompt`'s
   substance — the exact same two review-criteria paragraphs (owned files,
   concrete steps, no open decisions) and the exact same "brief" and
   "planFile" file restrictions — so the fallback reviews the identical
   thing under the identical rules; only the output-format instructions are
   rewritten to ask directly for the four schema fields, with `status`
   limited to `approved`/`rejected` (the fallback reviewer itself never
   reports "unavailable" as a verdict — a missing/failed agent call is
   detected separately, per decision 4, from the *absence* of a result, not
   from the model choosing that status).
6. **The fallback call passes `model` and `effort` options alongside the
   existing `schema` option** (the same options-object shape `agent()`
   already accepts elsewhere, e.g. `effort: 'low'` in
   `skills/tackle-tasks/test.workflow.js` line 126).
7. **Editing the plan file after a rejection is its own small subagent step**
   (`applyFixesBrief`), separate from the codex-running step and the
   fallback-reviewing step. This is necessary because deciding "unavailable"
   vs "rejected" vs "approved", and deciding whether to call the fallback,
   must happen in the workflow script's own JS control flow, which means the
   single monolithic subagent the file uses today (that ran codex, edited
   the plan, and re-ran codex all in one subagent call) has to become
   smaller steps orchestrated by JS: run-codex-once, run-fallback-once,
   apply-fixes-once.
8. **The original "cannot be fixed within the task's owned files → reject
   immediately, `revised: false`" shortcut must survive the split.** Today
   that decision is made by the single subagent reading its own FIXES text.
   In the split design, `applyFixesBrief` is the step already reading that
   FIXES text (it has to, to apply it), so it is the step that checks for
   this case: if the fixes say the plan can't be fixed within owned files,
   it returns `{applied: false}` without editing anything, and `verifyTask`
   treats `applied: false` as an immediate reject with `revised: false`
   instead of proceeding to a second round. Without this, the rewrite would
   blindly hand "this cannot be fixed" prose to the plan-file editor as if
   it were edit instructions, waste a second review round, and misreport
   `revised: true`.
9. **`applyFixesBrief` is only ever invoked with a genuine `rejected` round's
   `fixes` text — never with infra-error text from a missing/failed
   reviewer call.** A round whose status is `'unavailable'` (decision 4)
   short-circuits straight to a task-level rejection before
   `applyFixesBrief` is reached, so no round ever hands "reviewer returned no
   result" text to the plan-file editor as if it were edit instructions.

## Edit 1 — `skills/tackle-tasks/verify.workflow.js` (full-file replace)

Current text is the entire file, lines 1-88, read verbatim:

```
export const meta = {
  name: 'tackle-tasks-verify',
  description: 'Review each plan with codex, apply its suggested fixes once, and re-review before rejecting',
  phases: [{ title: 'Verify', detail: 'one codex verifier per planned task, one repair round each' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const PLANNED = ARGS.planned ?? []
const TASK_BY_NUMBER = new Map((ARGS.groups ?? []).flatMap((g) => g.tasks).map((t) => [t.number, t]))

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer' },
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    revised: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['task', 'verdict', 'revised', 'notes'],
}

const codexPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, say so explicitly in FIXES instead of inventing a fix.`

const verifierBrief = (t, planFile) => {
  const command = `codex exec -s read-only ${JSON.stringify(codexPrompt(t, planFile))}`
  return `Review the plan for task #${t.number} by running exactly this command:

${command}

Codex prints its verdict on the first line. The only file you may ever edit
is the plan file ${planFile} — never touch a source file, and never run any
command other than the codex command above.

If the first run prints APPROVED:
  return verdict "approved", revised false, and codex's reasoning in notes.

If the first run prints REJECTED:
  it also prints a FIXES section. Apply those fixes to ${planFile} so the plan
  says what codex asked for — edit only that file. Then run the exact same
  codex command a second time against the now-updated plan.

  If the second run prints APPROVED: return verdict "approved", revised true,
  and describe in notes what you changed in the plan.

  If the second run prints REJECTED: return verdict "rejected", revised true,
  and put codex's second-round PROBLEMS and FIXES text in notes verbatim —
  that reason is the only thing anyone sees before the task is skipped.

  If codex said the plan cannot be fixed within the task's owned files, do not
  invent a fix: return verdict "rejected", revised false, and copy that
  explanation into notes.

Never run codex more than twice.
Return {task: ${t.number}, verdict, revised, notes}.`
}

log(`verifying ${PLANNED.length} plan(s) with codex, up to one repair round each`)

const results = await parallel(PLANNED.map((p) => () =>
  agent(verifierBrief(TASK_BY_NUMBER.get(p.task), p.planFile), {
    label: `verify:${p.task}`,
    phase: 'Verify',
    schema: VERIFY_SCHEMA,
  })))

const verified = PLANNED.map((p, i) => results[i] ?? {
  task: p.task,
  verdict: 'rejected',
  revised: false,
  notes: 'verifier agent returned no result (killed, errored, or blocked)',
})

const planFileFor = (task) => PLANNED.find((p) => p.task === task).planFile

return {
  verified,
  approved: verified.filter((v) => v.verdict === 'approved').map((v) => ({ ...v, planFile: planFileFor(v.task) })),
  rejected: verified.filter((v) => v.verdict === 'rejected'),
  revisedCount: verified.filter((v) => v.revised).length,
}
```

Replace the entire file (lines 1-88) with:

```
export const meta = {
  name: 'tackle-tasks-verify',
  description: 'Review each plan with codex, falling back to a Claude reviewer when codex is unavailable, apply suggested fixes once, and re-review before rejecting',
  phases: [{ title: 'Verify', detail: 'one verifier per planned task per round — codex, or a fable-medium fallback when codex is unavailable — one repair round each' }],
}

const ARGS = typeof args === 'string' ? JSON.parse(args) : args
const PLANNED = ARGS.planned ?? []
const TASK_BY_NUMBER = new Map((ARGS.groups ?? []).flatMap((g) => g.tasks).map((t) => [t.number, t]))

const FALLBACK_MODEL = 'fable'
const FALLBACK_EFFORT = 'medium'

const ROUND_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'rejected', 'unavailable'] },
    reasoning: { type: 'string' },
    problems: { type: 'string' },
    fixes: { type: 'string' },
  },
  required: ['status', 'reasoning', 'problems', 'fixes'],
}

const FALLBACK_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'rejected'] },
    reasoning: { type: 'string' },
    problems: { type: 'string' },
    fixes: { type: 'string' },
  },
  required: ['status', 'reasoning', 'problems', 'fixes'],
}

const APPLY_SCHEMA = {
  type: 'object',
  properties: { applied: { type: 'boolean' } },
  required: ['applied'],
}

const codexPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

Print APPROVED or REJECTED alone on the first line.

If APPROVED, follow it with one short paragraph saying why.

If REJECTED, follow it with two sections. First "PROBLEMS:" — what is wrong and why. Then "FIXES:" — the concrete edits that would make this plan correct, specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, say so explicitly in FIXES instead of inventing a fix.`

const codexRunnerBrief = (t, planFile) => {
  const command = `codex exec -s read-only ${JSON.stringify(codexPrompt(t, planFile))}`
  return `Review the plan for task #${t.number} by running exactly this command, once:

${command}

Never edit any file, and never run any command other than the codex command
above.

Look at the command's exit status, stderr, and stdout to decide what
happened:

If it exits non-zero and stdout has no "PROBLEMS:" or "FIXES:" section, codex
itself failed to run (api overloaded, usage exceeded, not logged in, binary
missing from PATH, rate limited, or any other failure that produced no
verdict). Return status "unavailable", reasoning describing the failure from
stderr, and problems/fixes both "".

If stdout's first line is APPROVED, return status "approved", reasoning is
the short paragraph that follows, and problems/fixes both "".

If stdout's first line is REJECTED, return status "rejected", reasoning "",
problems is the text under "PROBLEMS:", and fixes is the text under
"FIXES:".

Return {status, reasoning, problems, fixes}.`
}

const fallbackPrompt = (t, planFile) => `Review an implementation plan. Read only these two files: the brief ${t.briefFile} and the plan ${planFile}. Do not edit anything.

Decide whether the plan is good enough to hand to an implementer: it stays within the task's owned files (${t.files.join(', ')}), it gives concrete steps rather than open design questions, and someone could follow it without having to decide anything the plan should have already decided.

If the plan is good enough, return status "approved", a short paragraph saying why in reasoning, and problems/fixes both "".

If the plan is not good enough, return status "rejected", reasoning "", problems set to what is wrong and why, and fixes set to the concrete edits that would make this plan correct — specific enough that someone could apply them to the plan file without making any further decisions of their own. If the plan cannot be fixed within the task's owned files, say so explicitly in fixes instead of inventing a fix.

Return {status, reasoning, problems, fixes}.`

const applyFixesBrief = (planFile, fixes) => `Apply these fixes to the plan file ${planFile} so it says what the
reviewer asked for. The only file you may ever edit is ${planFile} — never
touch a source file.

FIXES:
${fixes}

If the fixes above say the plan cannot be fixed within the task's owned
files, do not invent a fix — return {applied: false} without editing
anything.

Otherwise, apply the fixes and return {applied: true}.`

async function runCodex(t, planFile) {
  const result = await agent(codexRunnerBrief(t, planFile), {
    label: `verify:${t.number}:codex`,
    phase: 'Verify',
    schema: ROUND_SCHEMA,
  })
  return result ?? {
    status: 'unavailable',
    reasoning: 'codex verifier agent returned no result (killed, errored, or blocked)',
    problems: '',
    fixes: '',
  }
}

async function runFallback(t, planFile) {
  const result = await agent(fallbackPrompt(t, planFile), {
    label: `verify:${t.number}:${FALLBACK_MODEL}`,
    phase: 'Verify',
    model: FALLBACK_MODEL,
    effort: FALLBACK_EFFORT,
    schema: FALLBACK_SCHEMA,
  })
  return result ?? {
    status: 'unavailable',
    reasoning: `${FALLBACK_MODEL} fallback reviewer returned no result (killed, errored, or blocked)`,
    problems: '',
    fixes: '',
  }
}

async function runRound(t, planFile) {
  const probe = await runCodex(t, planFile)
  if (probe.status !== 'unavailable') return { ...probe, reviewer: 'codex' }
  const fallback = await runFallback(t, planFile)
  return { ...fallback, reviewer: FALLBACK_MODEL }
}

async function verifyTask(p) {
  const t = TASK_BY_NUMBER.get(p.task)
  const round1 = await runRound(t, p.planFile)

  if (round1.status === 'unavailable') {
    return {
      task: t.number,
      verdict: 'rejected',
      revised: false,
      notes: `codex and the ${FALLBACK_MODEL} fallback were both unavailable: ${round1.reasoning}`,
      reviewer: round1.reviewer,
    }
  }

  if (round1.status === 'approved') {
    return { task: t.number, verdict: 'approved', revised: false, notes: round1.reasoning, reviewer: round1.reviewer }
  }

  const applied = await agent(applyFixesBrief(p.planFile, round1.fixes), {
    label: `verify:${t.number}:apply-fixes`,
    phase: 'Verify',
    schema: APPLY_SCHEMA,
  })

  if (!applied?.applied) {
    return {
      task: t.number,
      verdict: 'rejected',
      revised: false,
      notes: `PROBLEMS:\n${round1.problems}\n\nFIXES:\n${round1.fixes}`,
      reviewer: round1.reviewer,
    }
  }

  const round2 = await runRound(t, p.planFile)

  if (round2.status === 'unavailable') {
    return {
      task: t.number,
      verdict: 'rejected',
      revised: true,
      notes: `codex and the ${FALLBACK_MODEL} fallback were both unavailable on the repair round: ${round2.reasoning}`,
      reviewer: round2.reviewer,
    }
  }

  if (round2.status === 'approved') {
    return { task: t.number, verdict: 'approved', revised: true, notes: round2.reasoning, reviewer: round2.reviewer }
  }

  return {
    task: t.number,
    verdict: 'rejected',
    revised: true,
    notes: `PROBLEMS:\n${round2.problems}\n\nFIXES:\n${round2.fixes}`,
    reviewer: round2.reviewer,
  }
}

log(`verifying ${PLANNED.length} plan(s), falling back to ${FALLBACK_MODEL}-${FALLBACK_EFFORT} when codex is unavailable, up to one repair round each`)

const results = await parallel(PLANNED.map((p) => () => verifyTask(p)))

const verified = PLANNED.map((p, i) => results[i] ?? {
  task: p.task,
  verdict: 'rejected',
  revised: false,
  notes: 'verifier returned no result (killed, errored, or blocked)',
  reviewer: 'codex',
})

const planFileFor = (task) => PLANNED.find((p) => p.task === task).planFile

return {
  verified,
  approved: verified.filter((v) => v.verdict === 'approved').map((v) => ({ ...v, planFile: planFileFor(v.task) })),
  rejected: verified.filter((v) => v.verdict === 'rejected'),
  revisedCount: verified.filter((v) => v.revised).length,
}
```

Notes on the diff:
- `VERIFY_SCHEMA` is deleted. It gated the shape of the single monolithic
  subagent call that no longer exists; nothing produces that exact shape via
  `agent()` any more (the final `{task, verdict, revised, notes, reviewer}`
  object is now assembled by plain JS in `verifyTask`, not schema-validated
  LLM output), so keeping the constant around would be dead code.
- `verifierBrief` is deleted, replaced by `codexRunnerBrief` (single codex
  run, no editing, reports `status`/`reasoning`/`problems`/`fixes`) plus
  `fallbackPrompt` (the fallback reviewer's own criteria-and-schema-matched
  prompt, see design decision 5) plus `applyFixesBrief` (the only step that
  edits the plan file) plus `runRound` (tries codex, falls back to `fable`
  on `'unavailable'`, tags the result with which reviewer answered).
- `codexPrompt` itself is unchanged, character-for-character, and is used
  only inside `codexRunnerBrief` (to build the literal shell command run
  through `codex exec`) — never passed directly to `agent()` as a fallback
  brief.
- `APPLY_SCHEMA`'s `applied` field is not just a completion receipt: when
  `applied` comes back `false`, `verifyTask` returns immediately with
  `revised: false`, reproducing the original "cannot be fixed within owned
  files → don't invent a fix" behavior instead of wasting a second review
  round on unfixable prose (see design decision 8).
- `runRound` is called independently for round 1 and round 2, so a task
  whose round 1 fell back to `fable` is not locked onto `fable` for round 2,
  and vice versa (design decision 2). Its `'unavailable'` status (design
  decision 4) short-circuits `verifyTask` before `applyFixesBrief` is ever
  reached, so infra-error text never gets treated as edit instructions
  (design decision 9).
- The final `return` block (verified/approved/rejected/revisedCount) is
  unchanged in shape; `reviewer` flows through automatically because it's
  already a property on each `v` object via the `...v` spread on line
  `approved: verified.filter(...).map((v) => ({ ...v, planFile: ... }))`.

## Edit 2 — `skills/tackle-tasks/SKILL.md` (lines 44-48)

Current text, lines 44-48, read verbatim:

```
Reviews each plan with codex. On a rejection the verifier applies codex's
suggested fixes to the plan file and re-runs codex once; a second rejection is
final. Returns `{verified, approved, rejected, revisedCount}`. If `approved` is
empty, stop and report — there is nothing to implement. Report `revisedCount`
so the user knows how many plan files codex rewrote.
```

Replace lines 44-48 with:

```
Reviews each plan with codex, falling back to a fable-medium Claude reviewer
whenever codex is unavailable (api overloaded, usage exceeded, not logged in,
binary missing from PATH, rate limited, or any other failure that produced no
verdict) — checked fresh on both the first review and the repair re-review, so
a task is never locked onto one reviewer for its whole run. On a rejection the
repair round applies the reviewer's suggested fixes to the plan file and
re-reviews once; a second rejection is final. Returns `{verified, approved,
rejected, revisedCount}`. Each entry in `verified` (and `approved`) carries a
`reviewer` field — `"codex"` or `"fable"` — naming which reviewer actually
produced the verdict, so a plan approved by the fallback is never reported as
codex-approved. If `approved` is empty, stop and report — there is nothing to
implement. Report `revisedCount` so the user knows how many plan files were
rewritten during a repair round.
```

Lines 40-43 (the `**Step 2 — verify.**` heading, `args = ...` line, and the
`planned` bullet) and lines 49 onward (the blank line before `**Step 3 —
implement.**`) are untouched.

## Owned files needing no edit

- **`scripts/approvalGate.ts`** — no edit. This is the whole-run approval
  digest/authorization gate (`recordApproval`, `issueApprovalAuthorization`,
  `checkAuthorizationDrift`, `finalizeApprovedRun`). It operates on
  `RunState`/`Approval`/`RunAuthorizationToken` after implementation and
  testing are done; it has no concept of codex, the verify phase, or a plan
  reviewer. Task 55's brief never names this file.
- **`scripts/mergeTaskWorktrees.ts`** — no edit. This is the merge-phase
  (step 6) git/worktree logic (`mergeGroupBranchIntoRepo`,
  `resolveGitlinkConflicts`, `findUnmergedTaskWorktrees`, the CLI entry
  points). It runs after verify/implement/test and never touches codex or
  plan review. Task 55's brief never names this file.
- **`skills/tackle-tasks/merge.workflow.js`** — no edit. This is the
  merge-phase workflow: it runs `mergeTaskWorktrees.ts` via `runBrief` and
  diagnoses merge failures via `diagnoseBrief`. Neither brief mentions
  codex, a plan reviewer, or anything this task changes. Task 55's brief
  never names this file.
- **`scripts/approvalReadiness.ts`** — no edit. This file gates
  `readyForApproval` on task/ownership/typecheck/sync/test-receipt state and
  per-group human/manual exercise-method review (`GroupReviewResult`,
  `ExerciseMethod`). It has no relationship to the codex/Claude plan-review
  verdict this task changes — "reviewer" and "review" in this file mean a
  human exercising a group's changes via a URL or command, not an automated
  plan verifier. Task 55's brief never names this file or its behavior.
- **`tests/approvalReadiness.test.ts`** — no edit, for the same reason:
  it tests `approvalReadiness.ts`, which is unchanged.
- **`skills/tackle-tasks/test.workflow.js`** — no edit. It consumes the
  `approved` array from step 2 only through `planFileFor`, line 75:
  `(ARGS.approved ?? []).find((a) => a.task === task)?.planFile ?? ''` —
  it reads only `.task` and `.planFile` off each entry. Adding a `reviewer`
  field to those entries (Edit 1) is an additional, ignored property; this
  file needs no change to keep working.

## Verification

Run these after making the two edits above:

1. `node --input-type=module --check < /Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/verify.workflow.js`
   Expected: no output, exit code 0. (`--input-type=module` forces ESM
   parsing so the file's top-level `export const` and top-level `await` are
   accepted regardless of the repo's `package.json` `"type"` setting; this
   only parses, it never executes, so the undefined `agent`/`parallel`/
   `log`/`args` globals are never touched.)

2. `rg -n "reviewer" /Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/verify.workflow.js`
   Expected: matches inside `runRound`, the `verifyTask` return statements,
   and the `verified` fallback object — confirms the `reviewer` field is
   present and comes from whichever reviewer answered each round.

3. `rg -n "verifierBrief|VERIFY_SCHEMA" /Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/verify.workflow.js`
   Expected: no matches (confirms the old monolithic-subagent function and
   its now-unused schema were fully removed, no dead code left behind).

4. `rg -n "applied\?\.applied" /Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/verify.workflow.js`
   Expected: 1 match — confirms the "cannot be fixed within owned files"
   short-circuit (design decision 8) is present.

5. `rg -n "fallbackPrompt|FALLBACK_SCHEMA|runRound" /Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/verify.workflow.js`
   Expected: matches for all three — confirms the fallback has its own
   prompt and schema (design decision 5) and that round selection goes
   through the shared `runRound` helper (design decision 2) instead of a
   per-task locked reviewer.

6. `rg -n "agent\(codexPrompt" /Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/verify.workflow.js`
   Expected: no matches — confirms `codexPrompt` is only used to build the
   `codex exec` shell command inside `codexRunnerBrief`, never passed
   straight to `agent()` as the fallback's brief.

7. `rg -n "reviewer" /Users/matkatmusicllc/Programming/taskTools/skills/tackle-tasks/SKILL.md`
   Expected: at least one match, inside the Step 2 paragraph — confirms the
   SKILL.md documentation mentions the new field.

8. `git diff --stat -- scripts/approvalGate.ts scripts/approvalReadiness.ts scripts/mergeTaskWorktrees.ts tests/approvalReadiness.test.ts skills/tackle-tasks/merge.workflow.js skills/tackle-tasks/test.workflow.js`
   Expected: empty output (confirms every owned file accounted for as
   "no edit" truly received no edits).

9. `bun test /Users/matkatmusicllc/Programming/taskTools/tests/approvalReadiness.test.ts`
   Expected: all existing tests still pass (confirms the untouched
   `approvalReadiness.ts` behavior is unaffected).
</content>
