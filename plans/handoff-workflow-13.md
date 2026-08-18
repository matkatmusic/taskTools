# Handoff — the [Plan] block is done; next is "codex reviews the plan"

Repo `/Users/matkatmusicllc/Programming/taskTools-86`, branch `fix-tackle-tasks-workflow-script-imports`.

Read `plans/handoff-workflow-12.md` first for the workflow/tracer state. It is still accurate.
This document covers only what changed after it, which is the **plan pipeline's prompt**, plus a
new file-injection mechanism you will want for the review prompt.

## Where the work stands

`plans/diagram/pipeline-plan.mmd` — the `[S]` box **"plan the task"** — is finished end to end.
Your job is the next diagram, `plans/diagram/pipeline-reviewPlan.mmd`, whose `[S]` box is
**"codex reviews the plan"** (`reviewPlanPrompt` / `reviewPlanQuestion`).

## 1. Read the generated prompt before you touch anything

```
node scripts/tackle-tasks/emitPipelineOutput.ts 35
```

Writes, and prints, five files:

```
plans/diagram/output renders/pipeline-output-task-35-safe-existing-worktree.md   trace + skill body
plans/diagram/output renders/35/plan.md          <- the finished one, use as the model
plans/diagram/output renders/35/review-plan.md   <- YOUR TARGET, still in the old shape
plans/diagram/output renders/35/implement.md
plans/diagram/output renders/35/review-tests.md
```

It stages a real worktree for task 35, renders, then tears it down. Exit 0 and a clean
`.taskTools/tasks.json` are both part of "it worked" — check `git status` after.

**Trap:** if a previous run died, a stale `task-35` worktree makes the next run exit 1. Run it
again; the second run succeeds. Teardown restores `tasks.json` first now, so a failed run no
longer leaves task 35 marked active.

The trace lines carry `[workflow.js:NNN]`, matched from the workflow source. Use them to jump from
a diagram box to the code that runs it.

## 2. What the finished plan prompt looks like, and why

`planPrompt` now lives in **`scripts/tackle-tasks/PlannerBodyEmitter.ts`**, not
`AgentPromptEmitter.ts`. That is the pattern the user wants: **one file per prompt definition,
`AgentPromptEmitter.ts` is only the dispatch hub that imports them.** When you rewrite the review
prompt, move `reviewPlanPrompt` + `reviewPlanQuestion` into their own file the same way.

Import direction, keep it one-way:

```
preparedTask.ts  ->  <role>BodyEmitter.ts  ->  AgentPromptEmitter.ts
```

`PreparedTask` and `loadPreparedTask` live in `scripts/tackle-tasks/preparedTask.ts` precisely so a
prompt file never imports the hub. Do not import `AgentPromptEmitter.ts` from a prompt file — that
was a real circular import and it is now fixed.

Structural decisions the user made for the plan prompt, apply them to the review prompt:

- **No ALL_CAPS placeholders, no trailing `---- DATA ----` block.** Every value is interpolated
  where it is used. The old `NAME = value` convention is gone from this prompt.
- **Templates are files, spliced at build time**, so the prompt body never goes stale:
  - `plans/plan-template.json` — the plan's shape. Valid JSON; `planShape()` parses it, sets the
    real task number, re-serializes. Content rules come from `~/.claude/guides/planning.md` and
    `~/.claude/guides/tdd.md`.
  - `plans/plan-output-template.json` — what the agent **returns**. Matches the workflow's
    `PLAN_RESULT` schema: `{outcome: PLAN|CLARIFY|ERROR, clarifyRequest}`.
  - You will likely want `plans/codex-review-template.json` for the review verdict, mirroring
    `codex-review.json` in `plans/plan-format.md`.
- **`## WHAT TO READ` lists files, it does not paste them** — see section 3.
- **No `OWNED FILES` section.** The user removed it deliberately: the file fence is enforced by the
  workflow's `DID_CHANGES_STAY_INSIDE_FENCE` box, not by asking the agent nicely.
- **Codex's notes go at the top**, under `## CODEX'S PREVIOUS REVIEW NOTES`, read from
  `task.codexReviewNotes`. **That field is not written by anything yet** — `UPDATE_TASK_ENTRY` in
  `pipeline-reviewPlan.mmd` is still an unwired `[C]` box that throws. The diagram says that box
  writes codex's notes into the tasks.json entry, and the planner reads them so a replan is not a
  bare retry. **Wiring that box is squarely in your scope**, and the planner side is already
  waiting for it — write `codexReviewNotes` and the notes start appearing with no prompt change.

## 3. The `/read-file` skill — new, working, use it

Files get into an agent's context **without spending a Read or Bash call**:

```
/read-file "/abs/path/one.ts" "/abs/path/two.ts"
```

The skill body does nothing. `scripts/readFileHook.ts` does the work, registered in
`hooks/hooks.json` on two events:

```
UserPromptSubmit | matcher=-      -> a human types /read-file <paths>
PostToolUse      | matcher=Skill  -> an agent invokes the read-file skill
```

Verified working in **all three** contexts: the main agent, a subagent, and a **workflow agent**.
Output arrives as `PostToolUse:Skill hook additional context:` with a `==== /path ====` header per
file. Quoted paths survive spaces.

The plan prompt uses it for brief + owned files + both guides + the return-shape template, in one
call. Do the same for the review prompt (brief, plan file, review template).

### Hard-won facts about hooks — do not relearn these

- **`!`cmd`` injection does NOT expand in an agent prompt.** Proven: a workflow agent received the
  literal text ``!`date +%H:%M:%S.%N` ``. It DOES expand in a skill body (`SKILL.md`), for main
  agents, subagents and workflow agents alike.
- **Register hooks in `hooks/hooks.json`, never in skill frontmatter.** A frontmatter hook registers
  only *when the skill is invoked*, so it cannot fire for that same invocation, and
  `/reload-skills` does not refresh it — stale registrations from earlier edits keep firing and
  poison every experiment. This cost most of a session.
- The `Skill` payload is
  `{"hook_event_name":"...","tool_name":"Skill","tool_input":{"skill":"read-file","args":"..."}}`.
  Echo `hook_event_name` back in your output; a name that disagrees with the firing event is dropped.
- A skill added to `skills/` is not visible in this checkout until it is symlinked into
  `.claude/skills/` (the symlink is gitignored). Plugin skills load from the installed plugin cache.
- Changing hooks needs `/reload-plugins`; changing skills needs `/reload-skills`.

## 4. Test and typecheck state

```
tests/tackle-tasks/AgentPromptEmitter.test.ts   50 pass, 0 fail
tests/PlannerBodyEmitter.test.ts                 pass
tests/readFileHook.test.ts                       6 pass
tests/emitPipelineOutput.test.ts                 1 pass
```

`tsc --noEmit` is clean **except** three files that were already broken before this work, all from
the deleted `ReceiptName` type named in handoff 12:

```
scripts/generatePipelinePaths.ts
scripts/tackle-tasks/stepPipeline.ts
tests/tracePipeline.test.ts
```

The 537-failure bucket from handoff 12 (459 stale `workflow matches tracer` fixtures + the tracer
tests) is unchanged. Do not read a big red number as your regression.

**When you change a prompt, its old tests are obsolete.** The user's rule: delete or update them,
never add production code to keep one green. Four `planPrompt` tests were deleted or rewritten this
session for exactly that reason.

**Fixtures must be able to exhibit the thing they test.** `makeFixture` had
`const worktree = projectRoot`, which made "does this role write into the worktree?" unanswerable.
It is now a real subdirectory.

## 5. Open items you inherit

1. **Wire `UPDATE_TASK_ENTRY`** — write `codexReviewNotes` onto the task entry, and raise the review
   counter. The planner already reads the field.
2. **Rewrite `reviewPlanPrompt` / `reviewPlanQuestion`** in the shape described above, in their own
   file.
3. **Shell-escaping hazard in `codexReviewInstructions`.** The question is `JSON.stringify`d into
   `codex exec -s read-only "<json>"`, which an agent runs verbatim. `JSON.stringify` does not
   escape backticks or `$`, and inside double quotes bash expands both. Today no prompt contains
   either, so it works — but a backtick added to the review question silently deletes text from what
   codex sees. Proven with `bash: OWNED_FILES: command not found`. `shellQuote` already exists in
   `AgentPromptEmitter.ts` and would fix it. **Do not put markdown backticks in either review
   question until this is fixed.**
4. `TESTS_FIELD` is still a trailing section in the plan prompt. It is a string in tasks.json, not a
   file, so `/read-file` cannot carry it, and `TESTS_FIELD_INSTRUCTION` is shared with
   `implementPrompt`. Left for whoever does the implement prompt.
5. Still open from handoff 12: regenerate the 459 fixtures, rewrite `tests/tracePipeline.test.ts`,
   fix the two non-test files that import `ReceiptName`, and the 90 unwired `[C]` boxes.

## 6. Working agreements the user enforces

- **One pass at a time.** Do not plan the whole remaining migration up front.
- **Small changes stay small.** No unrequested parameters, helpers, fallbacks, or try/catch.
- **Change one variable at a time when debugging.** Two simultaneous changes cost this session three
  separate rounds of wrong diagnosis.
- **Comments: one line, under 20 words.** A reflow hook joins multi-line comments and then rejects
  them. Do not defeat it with a blank `//` between sentences.
- **Stage only what you changed.** Never `git add -A`; the tree carries other sessions' untracked
  files. Check `git diff --cached` before writing a commit message.
- Run `npm test`, not `bun test`, and do not gate on `rg '^✖'` — it reports "all passing" on a red
  suite.
