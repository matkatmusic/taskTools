# Add an automated clarification phase to the tackle-tasks pipeline

## Problem

`ARE_2_CLARIFY_ROUNDS_DONE_Q` / `WRITE_CLARIFY_REQUEST` in
`pipeline-whatDidThePlannerReturn.mmd` only write the planner's `CLARIFY`
question into `tasks.json` and then loop straight back to
`DOCUMENT_GENERATION` → `PLAN_THE_TASK`. Nothing in the pipeline answers
the question — that step only exists today as the manual `/clarify-task`
skill, run by a human or another session out-of-band.

Consequence, confirmed against task 95's run: the planner asked CLARIFY
three separate times in one run, each blind (no new information supplied
between rounds), and burned the whole `MAX_ATTEMPTS` (2) budget without
ever getting an answer. Task exited `clarify-stuck` with no work landed.

## Current flow

```
WHAT_DID_THE_PLANNER_RETURN -- "CLARIFY" --> ARE_2_CLARIFY_ROUNDS_DONE_Q
ARE_2_CLARIFY_ROUNDS_DONE_Q -- "NO" --> WRITE_CLARIFY_REQUEST
ARE_2_CLARIFY_ROUNDS_DONE_Q -- "YES clarify-stuck" --> FAILURES_EXIT
WRITE_CLARIFY_REQUEST -- "docs mode: UPDATE" --> DOCUMENT_GENERATION
```

## Proposed flow

Insert a new box, `ANSWER_CLARIFY_REQUEST`, between `WRITE_CLARIFY_REQUEST`
and `DOCUMENT_GENERATION`:

```
WHAT_DID_THE_PLANNER_RETURN -- "CLARIFY" --> ARE_2_CLARIFY_ROUNDS_DONE_Q
ARE_2_CLARIFY_ROUNDS_DONE_Q -- "NO" --> WRITE_CLARIFY_REQUEST
ARE_2_CLARIFY_ROUNDS_DONE_Q -- "YES clarify-stuck" --> FAILURES_EXIT
WRITE_CLARIFY_REQUEST --> ANSWER_CLARIFY_REQUEST
ANSWER_CLARIFY_REQUEST -- "answered" --> DOCUMENT_GENERATION
ANSWER_CLARIFY_REQUEST -- "needs a human decision" --> FAILURES_EXIT
```

`ARE_2_CLARIFY_ROUNDS_DONE_Q` stays as the outer safety valve (still caps
at `MAX_ATTEMPTS`), but most rounds should now resolve automatically
instead of burning attempts on unanswered loops.

## ANSWER_CLARIFY_REQUEST behavior

An agent step (not a plain script — it has to read code and reason about
it, same shape as `PLAN_THE_TASK` / `CODEX_REVIEWS_PLAN`), running the
same logic `/clarify-task` runs by hand today:

1. Read the task's `clarifyRequest`.
2. Investigate the files it names plus the task's owned files — trace the
   live code path, not the task text, exactly as the `clarify-task` skill
   instructs.
3. Decide between two outcomes:
   - **Answerable from the code** → write the answer through the same
     path `scripts/clarifyTask.ts` already uses: append a dated
     "Clarification answer" to `description`, widen `files` with any new
     paths the answer names, set `blockedBy` if the answer reveals a real
     upstream dependency, clear `clarifyRequest`, clear
     `run.history`'s `attempts`/`countedPasses`, delete the worktree's
     `plans/checkpoint.json`. Continue to `DOCUMENT_GENERATION`.
   - **Genuine judgment call** (naming conventions, tradeoffs, ambiguous
     product/architecture scope — nothing the code can resolve) → route
     to `FAILURES_EXIT` with `exitType: "clarify-stuck"`, same terminal
     case as today, now reached only when auto-answering can't resolve
     it.

## Implementation surfaces

- `diagrams/tackle-tasks/pipeline-whatDidThePlannerReturn.mmd` — add the
  `ANSWER_CLARIFY_REQUEST` box and the edges above.
- `scripts/tackle-tasks/whatDidThePlannerReturn/ANSWER_CLARIFY_REQUEST.ts`
  — new step script/prompt builder, reusing `clarifyTask.ts`'s write path
  rather than re-implementing it.
- `scripts/generateSteps.ts` — add `ANSWER_CLARIFY_REQUEST` to the
  `whatDidThePlannerReturn` step list.

## Open question

Whether `ANSWER_CLARIFY_REQUEST` reuses the exact `/clarify-task` prompt
content or needs its own (narrower) prompt scoped to a single task's
single question, since `/clarify-task` today is written to batch-answer
several tasks at once from a user-supplied invocation.
