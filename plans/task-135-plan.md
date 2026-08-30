# Task 135 plan: applyFeedback stage and the three-round review loop

## Goal

Add a separate `applyFeedback` agent to `skills/tackle-tasks/task.workflow.js`'s plan
stage, and wrap the existing `verify` agent together with it in a loop of up to three
review rounds, so that:

- verify and applyFeedback are two separate agents (applyFeedback edits the plan file
  based on the verify agent's `notes`; verify never edits anything).
- The loop runs up to three `verify` calls, applying feedback between rounds, and stops
  early the moment a `verify` call returns `verdict: 'approved'`.
- After the rounds are exhausted, the plan stage returns regardless of the final
  verdict (this is already true structurally — `plan+implement` only branches on
  `planResult.status`, never on `verify.verdict` — no change needed for that part).
- The final `verify` object (carrying the reviewer's still-held objections, if any) is
  returned to the caller for a later approval gate to show.
- A `let reviewRounds` counter lives in `runPlan`'s own scope (not inside a separate
  hidden closure), so a later task (136) can decrement it too when it adds its own
  missingFiles-widening round.

`skills/tackle-tasks/verify.workflow.js` needs no edit: task 134 already moved its
"reviewing half" (the `codexPrompt`/`verifierBrief` pattern) into
`task.workflow.js`, and this task's own done-criteria explicitly excludes deleting
`verify.workflow.js`. Nothing else this task requires touches that file, so it is
left completely alone.

## Design decision: what "up to three rounds" means

The loop performs at most **three `verify` calls total**, with at most **two
`applyFeedback` calls** interleaved between them (one after round 1, one after round
2), stopping immediately if any `verify` call returns `approved`:

1. `verify` (round 1). If approved, stop.
2. `applyFeedback` (using round 1's notes), then `verify` (round 2). If approved, stop.
3. `applyFeedback` (using round 2's notes), then `verify` (round 3). Stop regardless of
   verdict — three rounds are used up.

This mirrors the two-call shape `verify.workflow.js` already used (verify, fix,
verify = 2 rounds) extended by one more round, and avoids a wasted final
`applyFeedback` call whose result would never be re-verified.

## Edits to `skills/tackle-tasks/task.workflow.js`

All line numbers below are from the current file as read.

### Edit 1 — add `APPLY_FEEDBACK_SCHEMA` after `VERIFY_SCHEMA` (between lines 39 and 41)

Current text (lines 38-41):
```
  required: ['task', 'verdict', 'notes', 'reviewer'],
}

const fileRetryPreamble = (t, missingFiles) => `Before planning, run these two commands with Bash from ${ARGS.repo} to gain read access to the files you flagged as missing, then continue below:
```

New text:
```
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

const fileRetryPreamble = (t, missingFiles) => `Before planning, run these two commands with Bash from ${ARGS.repo} to gain read access to the files you flagged as missing, then continue below:
```

### Edit 2 — add `applyFeedbackBrief` after `verifierBrief` (between lines 143 and 145)

Current text (lines 142-146):
```
Return {task: ${t.number}, verdict, notes, reviewer, missingFiles}.`
}

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
```

New text:
```
Return {task: ${t.number}, verdict, notes, reviewer, missingFiles}.`
}

const applyFeedbackBrief = (t, planFile, notes) => `Apply reviewer feedback to a plan file. The reviewer's PROBLEMS and FIXES are below, verbatim:

${notes}

Read ${planFile}, then edit it so it satisfies every fix listed above. The only file you may ever edit is ${planFile} — never touch a source file, the brief, or any other file, and never run any command.

If the text above has no FIXES section to apply (for example a MISSING_FILES section instead), make no edits and return applied false.

Return {task: ${t.number}, applied: true} once you have made the edits, or {task: ${t.number}, applied: false} if there was nothing to apply.`

// ponytail: null/undefined means the harness returned no result; re-spawn. Duplicated per file.
const retryAgent = async (spawn, attempts = 3) => {
```

### Edit 3 — add `MAX_REVIEW_ROUNDS` before `runPlan` (between lines 152 and 154)

Current text (lines 151-154):
```
  return null
}

const runPlan = async () => {
```

New text:
```
  return null
}

const MAX_REVIEW_ROUNDS = 3

const runPlan = async () => {
```

### Edit 4 — replace the single verify call at the end of `runPlan` with the loop (lines 180-189)

Current text (lines 180-189):
```
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

New text:
```
  if (planResult.status !== 'planned') return planResult
  const runVerify = async () => await retryAgent(() => agent(verifierBrief(preparedTask, preparedTask.planFile), { label: `verify:${N}`, phase: 'Plan', schema: VERIFY_SCHEMA })) ?? {
    task: N,
    verdict: 'rejected',
    notes: 'verifier agent returned no result after 3 attempts (killed, errored, or blocked)',
    reviewer: 'none',
    missingFiles: [],
  }
  let reviewRounds = MAX_REVIEW_ROUNDS
  let verify = await runVerify()
  reviewRounds -= 1
  while (verify.verdict !== 'approved' && reviewRounds > 0) {
    await retryAgent(() => agent(applyFeedbackBrief(preparedTask, preparedTask.planFile, verify.notes), { label: `applyFeedback:${N}`, phase: 'Plan', schema: APPLY_FEEDBACK_SCHEMA }))
    verify = await runVerify()
    reviewRounds -= 1
  }
  return { ...planResult, verify, reviewRounds }
}
```

No other edits to this file are needed. `runImplement`, `runRebaseTest`, `runMerge`,
`STAGE_RUNNERS`, and the final `return { task: N, stage: STAGE, results: await
runner() }` line are unaffected and stay exactly as they are.

## Edits to `skills/tackle-tasks/verify.workflow.js`

None. Reason: task 134 already copied this file's reviewing half (`codexPrompt` /
`verifierBrief`) into `task.workflow.js`. This task's own done-criteria says
"Deleting `verify.workflow.js` is NOT part of this task," and none of the other
done-criteria require changing its contents — the new `applyFeedback` agent is
written fresh into `task.workflow.js`, not extracted from this file's fix-applying
half. The file is left untouched.

## Verification

Run all commands from the repo root (`/Users/matkatmusicllc/Programming/taskTools-86`).

1. Confirm only the owned file that needed changes actually changed:
   ```
   git diff --stat skills/tackle-tasks/task.workflow.js skills/tackle-tasks/verify.workflow.js
   ```
   Expected: a stat line for `task.workflow.js` with insertions only (no deletions of
   existing lines besides the two replaced call sites), and no line at all for
   `verify.workflow.js` (0 changes).

2. Confirm the new pieces exist:
   ```
   rg -n "APPLY_FEEDBACK_SCHEMA|applyFeedbackBrief|MAX_REVIEW_ROUNDS|reviewRounds|runVerify" skills/tackle-tasks/task.workflow.js
   ```
   Expected: at least one match for each of `APPLY_FEEDBACK_SCHEMA`,
   `applyFeedbackBrief`, `MAX_REVIEW_ROUNDS`, `reviewRounds`, and `runVerify`.

3. Confirm the edited file still parses as valid JS in the shape the harness runs it
   in. The file references free identifiers `args`, `log`, `agent`, `parallel` (never
   declared/imported) and uses a top-level `await` and a top-level `return`, so it is
   evaluated as the body of an async function — reproduce that with `AsyncFunction`
   (which only parses the body; it does not invoke it, so no real `agent`/`log`
   implementation is needed):
   ```
   node -e "
   const fs = require('fs');
   let src = fs.readFileSync('skills/tackle-tasks/task.workflow.js', 'utf8');
   src = src.replace('export const meta', 'const meta');
   const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
   new AsyncFunction('args','log','agent','parallel', src);
   console.log('syntax OK');
   "
   ```
   Expected output: `syntax OK` with no thrown `SyntaxError`.

4. Confirm the round-counting logic itself (verify/applyFeedback interleaving and the
   round counter) behaves as designed, independent of the real `agent`/harness, by
   replaying the exact control flow added in Edit 4 against two fake sequences:

   Worst case — reviewer rejects every time:
   ```
   node -e "
   const MAX_REVIEW_ROUNDS = 3;
   const verdicts = ['rejected','rejected','rejected','rejected'];
   let i = 0;
   const runVerify = async () => ({ verdict: verdicts[i++] });
   (async () => {
     let reviewRounds = MAX_REVIEW_ROUNDS;
     let verify = await runVerify();
     reviewRounds -= 1;
     let applyCalls = 0;
     while (verify.verdict !== 'approved' && reviewRounds > 0) {
       applyCalls += 1;
       verify = await runVerify();
       reviewRounds -= 1;
     }
     console.log(JSON.stringify({ verifyCalls: i, applyCalls, reviewRounds }));
   })();
   "
   ```
   Expected output: `{"verifyCalls":3,"applyCalls":2,"reviewRounds":0}` — exactly
   three verify calls, exactly two applyFeedback calls, counter exhausted at 0.

   Early-approval case — reviewer approves immediately:
   ```
   node -e "
   const MAX_REVIEW_ROUNDS = 3;
   const verdicts = ['approved'];
   let i = 0;
   const runVerify = async () => ({ verdict: verdicts[i++] });
   (async () => {
     let reviewRounds = MAX_REVIEW_ROUNDS;
     let verify = await runVerify();
     reviewRounds -= 1;
     let applyCalls = 0;
     while (verify.verdict !== 'approved' && reviewRounds > 0) {
       applyCalls += 1;
       verify = await runVerify();
       reviewRounds -= 1;
     }
     console.log(JSON.stringify({ verifyCalls: i, applyCalls, reviewRounds }));
   })();
   "
   ```
   Expected output: `{"verifyCalls":1,"applyCalls":0,"reviewRounds":2}` — one verify
   call, no wasted applyFeedback call, two rounds left unused.
